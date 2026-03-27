const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

function createShanghaiDate(dateInput = new Date()) {
  if (dateInput instanceof Date) {
    return dateInput;
  }

  if (typeof dateInput === 'string') {
    const matched = dateInput.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (matched) {
      const [, year, month, day] = matched;
      return new Date(`${year}-${month}-${day}T12:00:00+08:00`);
    }
  }

  return new Date(dateInput);
}

function formatShanghaiParts(dateInput = new Date(), options = {}) {
  const date = createShanghaiDate(dateInput);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI_TIME_ZONE,
    ...options
  }).formatToParts(date);
}

export function getShanghaiDateKey(dateInput = new Date()) {
  const parts = formatShanghaiParts(dateInput, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  if (!parts) {
    return '';
  }

  const year = parts.find(part => part.type === 'year')?.value;
  const month = parts.find(part => part.type === 'month')?.value;
  const day = parts.find(part => part.type === 'day')?.value;

  return `${year}-${month}-${day}`;
}

export function formatShanghaiDate(dateInput = new Date()) {
  return getShanghaiDateKey(dateInput);
}

export function formatShanghaiDisplayDate(dateInput = new Date()) {
  const date = createShanghaiDate(dateInput);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  }).format(date);
}

export function formatShanghaiArticleDate(dateInput = new Date()) {
  const date = createShanghaiDate(dateInput);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

export { SHANGHAI_TIME_ZONE, createShanghaiDate };