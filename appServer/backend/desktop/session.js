import { parseUciOption, isValidSavedUciOptionValue, formatSetOption } from '../engineOptions.js';

export function validateDesktopSettings(input) {
    if(!input || typeof input.engineId !== 'string' || !input.engineId)
        throw new Error('Select an engine first.');
    const depth = Number(input.depth ?? 14);
    const movetime = Number(input.movetime ?? 1000);
    if(!Number.isInteger(depth) || depth < 1 || depth > 100)
        throw new Error('Depth must be between 1 and 100.');
    if(!Number.isInteger(movetime) || movetime < 100 || movetime > 60000)
        throw new Error('Analysis time must be between 100 and 60000 ms.');
    const options = input.options ?? {};
    if(!options || typeof options !== 'object' || Array.isArray(options)
        || Object.keys(options).length > 64) throw new Error('UCI options must be a JSON object (at most 64 entries).');
    for(const [name, value] of Object.entries(options)) {
        if(!name || name.length > 128 || /[\r\n\0]/.test(name)
            || !['string', 'boolean', 'number'].includes(typeof value)
            || String(value).length > 1024 || /[\r\n\0]/.test(String(value))
            || (typeof value === 'number' && !Number.isFinite(value)))
            throw new Error('Invalid UCI option.');
    }
    const launchParams = input.launchParams ?? '';
    if(typeof launchParams !== 'string' || launchParams.length > 1024
        || /[^a-zA-Z0-9._\-=/+:\s]/.test(launchParams) || /[\r\n]/.test(launchParams))
        throw new Error('Invalid engine launch parameters.');
    return { engineId: input.engineId, depth, movetime, options: { ...options }, launchParams };
}

export function isFen(value) {
    return typeof value === 'string' && value.length < 160
        && /^(?:[prnbqkPRNBQK1-8]+\/){7}[prnbqkPRNBQK1-8]+ [wb] (?:-|K?Q?k?q?) (?:-|[a-h][36]) \d+ [1-9]\d*$/.test(value)
        && value.split(' ')[0].split('/').every(row => [...row].reduce((sum, ch) => sum + (Number(ch) || 1), 0) === 8);
}

// Dependency injection keeps protocol ordering testable without Electron or a GPU.
export class DesktopSession {
    constructor({ start, send, kill, events, onStatus = () => {}, onMoves = () => {} }) {
        Object.assign(this, { startProcess: start, send, kill, events, onStatus, onMoves });
        this.onEvent = this.onEvent.bind(this);
        this.events.on('uci', this.onEvent);
        this.onDeath = event => {
            if(this.identifier && this.matches(event)) this.fail(new Error(event.reason || 'Engine stopped.'));
        };
        this.events.on('death', this.onDeath);
        this.sequence = 0;
    }

    matches(event) {
        return event.engineId === this.identifier?.engineId
            && event.profileName === this.identifier?.profileName && event.instanceId === this.identifier?.instanceId;
    }

    async start(engine, settings) {
        await this.stop();
        const sequence = ++this.sequence;
        this.settings = validateDesktopSettings(settings);
        this.identifier = {
            engineId: engine.engineId, profileName: 'Desktop', instanceId: 'desktop',
            identifierKey: JSON.stringify([engine.engineId, 'Desktop', 'desktop']),
            savedOptionsIdentifierKey: `Desktop_${engine.engineId}`,
            launchParams: this.settings.launchParams
        };
        this.options = new Map();
        this.phase = 'starting';
        this.onStatus('Starting engine…');
        await this.startProcess(engine.path, this.identifier);
        if(sequence !== this.sequence) return;
        await new Promise((resolve, reject) => {
            this.ready = { resolve, reject };
            this.timer = setTimeout(() => this.fail(new Error('Engine UCI handshake timed out.')), 15000);
            this.phase = 'uci';
            this.send('uci', this.identifier);
        });
        if(sequence === this.sequence) this.onStatus('Waiting for a supported board…');
    }

    onEvent(event) {
        if(!this.identifier || !this.matches(event)) return;
        const line = event.line.trim();
        const option = parseUciOption(line);
        if(option) {
            const minimum = /\bmin\s+(-?\d+)/.exec(line);
            const maximum = /\bmax\s+(-?\d+)/.exec(line);
            if(minimum) option.minimum = Number(minimum[1]);
            if(maximum) option.maximum = Number(maximum[1]);
            if(option.type === 'combo') option.variants = line.split(/\s+var\s+/).slice(1);
            this.options.set(option.name, option);
        }
        if(line === 'uciok' && this.phase === 'uci') {
            try {
                for(const [name, value] of Object.entries(this.settings.options)) {
                    const definition = this.options.get(name);
                    if(!definition || definition.type === 'button' || !isValidSavedUciOptionValue(value, definition)
                        || (definition.type === 'spin' && ((definition.minimum!==undefined && Number(value)<definition.minimum)
                            || (definition.maximum!==undefined && Number(value)>definition.maximum)))
                        || (definition.type === 'combo' && !definition.variants.includes(String(value))))
                        throw new Error(`Unsupported or invalid UCI option: ${name}`);
                    this.send(formatSetOption(name, value), this.identifier);
                }
                this.phase = 'ready-wait';
                this.send('isready', this.identifier);
            } catch(error) { this.fail(error); }
        } else if(line === 'readyok' && this.phase === 'ready-wait') {
            clearTimeout(this.timer);
            this.phase = 'ready';
            this.ready?.resolve();
            this.ready = null;
        } else if(line.startsWith('info string Maia error:')) {
            this.fail(new Error(line.slice(12)));
        } else if(this.active && /^info\s/.test(line) && !line.startsWith('info string')) {
            const pv = /\bpv\s+([a-h][1-8][a-h][1-8][qrbn]?)(?:\s|$)/.exec(line);
            const ranking = Number(/\bmultipv\s+(\d+)/.exec(line)?.[1] || 1);
            if(pv && ranking >= 1 && ranking <= 5 && this.active.fen === this.latest) {
                this.active.moves.set(ranking, pv[1]);
                this.publish();
            }
        } else if(/^bestmove\s/.test(line) && this.active) {
            clearTimeout(this.stopTimer);
            this.stopping = false;
            const move = line.split(/\s+/)[1];
            if(this.active.fen === this.latest && /^[a-h][1-8][a-h][1-8][qrbn]?$/.test(move)) {
                this.active.moves.set(1, move);
                this.publish();
            }
            this.active = null;
            this.flush();
        }
    }

    publish() {
        this.onMoves({ fen: this.active.fen,
            moves: [...this.active.moves].sort(([a], [b]) => a - b).map(([, move]) => move) });
    }

    analyze(fen) {
        if(this.phase !== 'ready') throw new Error('Desktop engine is not ready.');
        if(!isFen(fen)) throw new Error('Invalid FEN.');
        if(this.latest === fen) return;
        this.latest = fen;
        this.pending = fen;
        this.onMoves(null);
        if(this.active) this.requestStop();
        else this.flush();
    }

    flush() {
        if(!this.pending || this.active || this.phase !== 'ready') return;
        const fen = this.pending;
        this.pending = null;
        this.active = { fen, moves: new Map() };
        this.send(`position fen ${fen}`, this.identifier);
        this.send(`go depth ${this.settings.depth} movetime ${this.settings.movetime}`, this.identifier);
    }

    requestStop() {
        if(this.stopping) return;
        this.stopping = true;
        this.stopTimer = setTimeout(() => this.fail(new Error('Engine did not finish after stop; restart watching.')), 10000);
        this.send('stop', this.identifier);
    }

    pause() {
        this.latest = this.pending = null;
        this.onMoves(null);
        if(this.active) this.requestStop();
    }

    fail(error) {
        clearTimeout(this.timer);
        clearTimeout(this.stopTimer);
        this.phase = 'error';
        this.latest = this.pending = this.active = null;
        this.onMoves(null);
        this.onStatus(error.message, true);
        this.ready?.reject(error);
        this.ready = null;
    }

    async stop() {
        ++this.sequence;
        clearTimeout(this.timer);
        clearTimeout(this.stopTimer);
        const identifier = this.identifier;
        this.identifier = null;
        this.phase = 'stopped';
        this.ready?.reject(new Error('Desktop session stopped.'));
        this.ready = null;
        this.latest = this.pending = this.active = null;
        this.stopping = false;
        this.onMoves(null);
        if(identifier) await this.kill(identifier);
    }

    async dispose() {
        await this.stop();
        this.events.off('uci', this.onEvent);
        this.events.off('death', this.onDeath);
    }
}
