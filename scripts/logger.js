import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.dirname(__dirname);

let currentLogFile = null;

function ensureLogDirectory(logDir) {
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join('') + '-' + [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('');
}

function appendLogLine(line) {
  if (!currentLogFile) {
    return;
  }

  fs.appendFileSync(currentLogFile, `${line}\n`, 'utf-8');
}

export function initializeRunLogger(settings = {}) {
  const configuredDir = settings?.logging?.dir || path.dirname(settings?.logging?.file || './logs/ai-daily.log');
  const resolvedDir = path.resolve(ROOT_DIR, configuredDir || './logs');
  ensureLogDirectory(resolvedDir);

  const filename = `daily-report-${formatTimestamp()}.log`;
  currentLogFile = path.join(resolvedDir, filename);
  fs.writeFileSync(currentLogFile, '', 'utf-8');
  return currentLogFile;
}

export function getCurrentLogFile() {
  return currentLogFile;
}

function write(level, icon, message, args, writer) {
  const renderedMessage = [message, ...args].map((item) => {
    if (item instanceof Error) {
      return item.stack || item.message;
    }
    return typeof item === 'string' ? item : JSON.stringify(item);
  }).join(' ');

  const line = `[${new Date().toISOString()}] ${icon} ${renderedMessage}`;
  writer(line);
  appendLogLine(line);
}

export const log = {
  info(message, ...args) {
    write('info', 'ℹ️', message, args, console.log);
  },
  success(message, ...args) {
    write('success', '✓', message, args, console.log);
  },
  warn(message, ...args) {
    write('warn', '⚠', message, args, console.warn);
  },
  error(message, ...args) {
    write('error', '✗', message, args, console.error);
  }
};