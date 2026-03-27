import { createShanghaiDate, getShanghaiDateKey } from './timezone.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export function getFreshnessDays(settings = {}) {
  const configured = settings?.fetch?.freshnessDays;
  if (typeof configured === 'number' && configured >= 1) {
    return Math.floor(configured);
  }
  return 2;
}

export function isWithinFreshnessWindow(dateInput, freshnessDays = 2, referenceDate = new Date()) {
  if (!dateInput) {
    return false;
  }

  const targetDate = createShanghaiDate(dateInput);
  const currentDate = createShanghaiDate(referenceDate);
  if (Number.isNaN(targetDate.getTime()) || Number.isNaN(currentDate.getTime())) {
    return false;
  }

  const targetKey = getShanghaiDateKey(targetDate);
  const currentKey = getShanghaiDateKey(currentDate);
  if (!targetKey || !currentKey) {
    return false;
  }

  const normalizedTarget = createShanghaiDate(targetKey);
  const normalizedCurrent = createShanghaiDate(currentKey);
  const diffDays = Math.floor((normalizedCurrent.getTime() - normalizedTarget.getTime()) / DAY_MS);

  return diffDays >= 0 && diffDays < Math.max(1, freshnessDays);
}