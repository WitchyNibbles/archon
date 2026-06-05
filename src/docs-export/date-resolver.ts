function isoDateFromParts(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseIsoDate(isoDate: string): { year: number; month: number; day: number } {
  const match = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/.exec(isoDate);
  if (!match?.groups) {
    throw new Error(`Invalid ISO date: ${isoDate}`);
  }

  return {
    year: Number.parseInt(match.groups["year"]!, 10),
    month: Number.parseInt(match.groups["month"]!, 10),
    day: Number.parseInt(match.groups["day"]!, 10)
  };
}

function shiftIsoDate(isoDate: string, days: number): string {
  const { year, month, day } = parseIsoDate(isoDate);
  const shifted = new Date(Date.UTC(year, month - 1, day + days));
  return isoDateFromParts(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate());
}

function zonedDateParts(now: Date, timezone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  const parts = formatter.formatToParts(now);
  const year = Number.parseInt(parts.find((part) => part.type === "year")?.value ?? "", 10);
  const month = Number.parseInt(parts.find((part) => part.type === "month")?.value ?? "", 10);
  const day = Number.parseInt(parts.find((part) => part.type === "day")?.value ?? "", 10);

  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    throw new Error(`Could not resolve date parts for timezone ${timezone}`);
  }

  return { year, month, day };
}

function isoWeekday(isoDate: string): number {
  const { year, month, day } = parseIsoDate(isoDate);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

export function validateTimezone(timezone: string): string {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }

  return timezone;
}

export function currentIsoDateInTimezone(now: Date, timezone: string): string {
  validateTimezone(timezone);
  const parts = zonedDateParts(now, timezone);
  return isoDateFromParts(parts.year, parts.month, parts.day);
}

export function resolveDateRangeFromQuery(
  rawQuery: string,
  options: {
    timezone: string;
    now?: Date | undefined;
  }
): { dateFrom?: string | undefined; dateTo?: string | undefined } {
  const normalized = rawQuery.trim().toLowerCase();
  const timezone = validateTimezone(options.timezone);
  const now = options.now ?? new Date();
  const today = currentIsoDateInTimezone(now, timezone);

  const explicitRangeMatch =
    /(?:from\s+)?(?<from>\d{4}-\d{2}-\d{2})\s+(?:to|through|until|-)\s+(?<to>\d{4}-\d{2}-\d{2})/.exec(normalized);
  if (explicitRangeMatch?.groups) {
    return {
      dateFrom: explicitRangeMatch.groups.from,
      dateTo: explicitRangeMatch.groups.to
    };
  }

  const explicitDateMatch = /\b(?<date>\d{4}-\d{2}-\d{2})\b/.exec(normalized);
  if (explicitDateMatch?.groups?.date) {
    return {
      dateFrom: explicitDateMatch.groups.date,
      dateTo: explicitDateMatch.groups.date
    };
  }

  const nthOfMonthMatch = /\b(?:the\s+)?(?<day>\d{1,2})(?:st|nd|rd|th)\s+of\s+this\s+month\b/.exec(normalized);
  if (nthOfMonthMatch?.groups?.day) {
    const day = Number.parseInt(nthOfMonthMatch.groups.day, 10);
    const { year, month } = zonedDateParts(now, timezone);
    const resolved = isoDateFromParts(year, month, day);
    return {
      dateFrom: resolved,
      dateTo: resolved
    };
  }

  if (normalized.includes("yesterday")) {
    const yesterday = shiftIsoDate(today, -1);
    return {
      dateFrom: yesterday,
      dateTo: yesterday
    };
  }

  if (normalized.includes("today")) {
    return {
      dateFrom: today,
      dateTo: today
    };
  }

  if (normalized.includes("this week")) {
    const start = shiftIsoDate(today, -(isoWeekday(today) - 1));
    return {
      dateFrom: start,
      dateTo: today
    };
  }

  if (normalized.includes("this month")) {
    const { year, month } = zonedDateParts(now, timezone);
    return {
      dateFrom: isoDateFromParts(year, month, 1),
      dateTo: today
    };
  }

  return {};
}
