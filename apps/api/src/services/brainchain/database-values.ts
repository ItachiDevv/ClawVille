/** Drizzle changes the shared postgres-js timestamp parser to return strings. */
export function databaseDate(value:unknown):Date{
  const date=value instanceof Date?value:typeof value==='string'?new Date(value):new Date(NaN);
  if(!Number.isFinite(date.getTime()))throw new Error('Invalid database timestamp');
  return date;
}
