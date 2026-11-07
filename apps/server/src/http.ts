// Small helpers shared by the server's route files.
import { createHash } from 'node:crypto';

export const TZ = 'Asia/Shanghai';
const DAY = 86_400_000;
export const shanghaiDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
export const addDays = (date: string, n: number) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
export const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
export const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
export const isKey = (s: unknown): s is string => typeof s === 'string' && /^[A-Za-z0-9-]+@\d+\.\d+$/.test(s);

export class HttpError extends Error { constructor(readonly status: number, msg: string, readonly extra?: Record<string, unknown>) { super(msg); } }
export const fail = (status: number, msg: string, extra?: Record<string, unknown>): never => { throw new HttpError(status, msg, extra); };
