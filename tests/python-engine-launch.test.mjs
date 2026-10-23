import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { normalizeEngineRuntime, buildEngineLaunch } from '../appServer/backend/engineLaunch.js';

const script = path.resolve('my engines', 'maia adapter.py');

test('native engine launch stays compatible', () => {
    const engine = { path: path.resolve('engines', 'stockfish') };
    assert.deepEqual(normalizeEngineRuntime(engine), {});
    assert.deepEqual(buildEngineLaunch(engine, ['--threads=2']), {
        runtime: 'native', command: engine.path, args: ['--threads=2'], cwd: path.dirname(engine.path)
    });
});

test('Python interpreter and script paths with spaces remain single argv entries', () => {
    const pythonExecutable = path.resolve('My Python', 'python');
    const engine = { path: script, ...normalizeEngineRuntime({ path: script, pythonExecutable }) };
    assert.deepEqual(buildEngineLaunch(engine, ['--device=cpu']), {
        runtime: 'python', command: pythonExecutable,
        args: ['-u', script, '--device=cpu'], cwd: path.dirname(script)
    });
});

test('recognizes uppercase extensions and trims interpreter input', () => {
    assert.deepEqual(normalizeEngineRuntime({ path: 'ENGINE.PY', pythonExecutable: ' python3 ' }), {
        runtime: 'python', pythonExecutable: 'python3'
    });
});

test('rejects missing, relative, quoted and compound Python commands', () => {
    for(const pythonExecutable of [undefined, '', ' ', 'python -u', 'py -3.12', './venv/python',
        'python\nquit', 'python\0', '"/some/python"', 'python;id', 'python.cmd', 'python.bat']) {
        assert.throws(() => normalizeEngineRuntime({ path: script, pythonExecutable }));
    }
});

test('persisted Python config is revalidated before spawn', () => {
    assert.throws(() => buildEngineLaunch({ path: script, runtime: 'python' }));
});

test('launches a real Python UCI script from a path with spaces', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'acas python '));
    try {
        const file = path.join(directory, 'test engine.py');
        await fs.writeFile(file, `import sys, os, json
for line in sys.stdin:
    if line.strip() == 'uci':
        print('uciok', flush=True)
    elif line.strip() == 'quit':
        print(json.dumps({'args': sys.argv[1:], 'cwd': os.getcwd()}), flush=True)
        break
`);
        const engine = { path: file, ...normalizeEngineRuntime({ path: file,
            pythonExecutable: process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3') }) };
        const launch = buildEngineLaunch(engine, ['--device=cpu']);
        const result = await new Promise((resolve, reject) => {
            const child = spawn(launch.command, launch.args, { cwd: launch.cwd, shell: false });
            let stdout = '', stderr = '';
            const timer = setTimeout(() => { child.kill(); reject(new Error('Python fixture timed out')); }, 5000);
            child.stdout.on('data', chunk => { stdout += chunk; });
            child.stderr.on('data', chunk => { stderr += chunk; });
            child.on('error', error => { clearTimeout(timer); reject(error); });
            child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
            child.stdin.end('uci\nquit\n');
        });
        assert.equal(result.code, 0, result.stderr);
        const lines = result.stdout.trim().split(/\r?\n/);
        assert.equal(lines[0], 'uciok');
        assert.deepEqual(JSON.parse(lines[1]), { args: ['--device=cpu'], cwd: directory });
    } finally {
        await fs.rm(directory, { recursive: true, force: true });
    }
});
