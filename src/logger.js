'use strict'

/** Tiny levelled logger with timestamps. No dependencies. */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 }
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' }
const RESET = '\x1b[0m'

function createLogger (level = 'info', { colors = process.stdout.isTTY } = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info

  const write = (name, args) => {
    const time = new Date().toISOString().slice(11, 19)
    const tag = colors ? `${COLORS[name]}${name.toUpperCase().padEnd(5)}${RESET}` : name.toUpperCase().padEnd(5)
    const stream = name === 'error' || name === 'warn' ? console.error : console.log
    stream(`${time} ${tag}`, ...args)
  }

  return {
    level,
    debug: (...a) => threshold <= LEVELS.debug && write('debug', a),
    info: (...a) => threshold <= LEVELS.info && write('info', a),
    warn: (...a) => threshold <= LEVELS.warn && write('warn', a),
    error: (...a) => threshold <= LEVELS.error && write('error', a)
  }
}

module.exports = { createLogger, LEVELS }
