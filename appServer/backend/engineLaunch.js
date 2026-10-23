import path from 'node:path';

// A Python executable is one argv entry, not a shell command. Spaces in absolute
// venv paths are preserved; interpreter flags belong in the launcher, not this field.
export function normalizeEngineRuntime(fileInfo) {
    if(!/\.py$/i.test(fileInfo.path)) return {};
    const executable = fileInfo.pythonExecutable;
    if(typeof executable !== 'string' || !executable.trim())
        throw new Error('Select a Python interpreter for this .py engine.');
    const pythonExecutable = executable.trim();
    if(/[\0\r\n"]/.test(pythonExecutable)
        || (!path.isAbsolute(pythonExecutable) && !/^[\w.-]+$/.test(pythonExecutable))
        || /\.(bat|cmd)$/i.test(pythonExecutable))
        throw new Error('Use a Python command (e.g. python) or an unquoted absolute executable path, without arguments.');
    return { runtime: 'python', pythonExecutable };
}

export function buildEngineLaunch(engine, args = []) {
    const cwd = path.dirname(engine.path);
    if(engine.runtime !== 'python')
        return { runtime: 'native', command: engine.path, args, cwd };
    const { pythonExecutable } = normalizeEngineRuntime(engine);
    return {
        runtime: 'python', command: pythonExecutable,
        args: ['-u', engine.path, ...args], cwd
    };
}
