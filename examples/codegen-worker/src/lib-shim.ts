/**
 * Minimal lib.d.ts shim for in-memory type checking.
 *
 * Provides the core global types TypeScript requires to function.
 * This avoids bundling the full 500KB+ lib.d.ts files.
 */

export const LIB_SHIM = `
// Core types TypeScript requires
interface Array<T> { length: number; [n: number]: T; push(...items: T[]): number; pop(): T | undefined; map<U>(fn: (value: T, index: number, array: T[]) => U): U[]; filter(fn: (value: T, index: number, array: T[]) => boolean): T[]; filter<S extends T>(fn: (value: T, index: number, array: T[]) => value is S): S[]; find(fn: (value: T, index: number) => boolean): T | undefined; forEach(fn: (value: T, index: number, array: T[]) => void): void; reduce<U>(fn: (prev: U, curr: T, index: number) => U, init: U): U; includes(value: T): boolean; indexOf(value: T): number; slice(start?: number, end?: number): T[]; splice(start: number, deleteCount?: number, ...items: T[]): T[]; join(sep?: string): string; some(fn: (value: T, index: number) => boolean): boolean; every(fn: (value: T, index: number) => boolean): boolean; flat<D extends number = 1>(depth?: D): T[]; flatMap<U>(fn: (value: T, index: number) => U | U[]): U[]; sort(fn?: (a: T, b: T) => number): T[]; reverse(): T[]; concat(...items: (T | T[])[]): T[]; entries(): IterableIterator<[number, T]>; keys(): IterableIterator<number>; values(): IterableIterator<T>; [Symbol.iterator](): IterableIterator<T>; }
interface ReadonlyArray<T> { length: number; [n: number]: T; map<U>(fn: (value: T, index: number) => U): U[]; filter(fn: (value: T, index: number) => boolean): T[]; find(fn: (value: T, index: number) => boolean): T | undefined; forEach(fn: (value: T, index: number) => void): void; includes(value: T): boolean; indexOf(value: T): number; slice(start?: number, end?: number): T[]; join(sep?: string): string; some(fn: (value: T, index: number) => boolean): boolean; every(fn: (value: T, index: number) => boolean): boolean; reduce<U>(fn: (prev: U, curr: T, index: number) => U, init: U): U; [Symbol.iterator](): IterableIterator<T>; }
interface ArrayConstructor { new <T>(...items: T[]): T[]; isArray(arg: any): arg is any[]; from<T>(iterable: Iterable<T>): T[]; }
declare var Array: ArrayConstructor;
interface String { length: number; charAt(pos: number): string; charCodeAt(pos: number): number; indexOf(str: string, pos?: number): number; lastIndexOf(str: string, pos?: number): number; includes(str: string): boolean; startsWith(str: string): boolean; endsWith(str: string): boolean; slice(start?: number, end?: number): string; substring(start: number, end?: number): string; toLowerCase(): string; toUpperCase(): string; trim(): string; trimStart(): string; trimEnd(): string; split(sep: string | RegExp, limit?: number): string[]; replace(pattern: string | RegExp, replacement: string | ((match: string, ...args: any[]) => string)): string; replaceAll(pattern: string | RegExp, replacement: string): string; match(regexp: RegExp): RegExpMatchArray | null; padStart(length: number, fill?: string): string; padEnd(length: number, fill?: string): string; repeat(count: number): string; [Symbol.iterator](): IterableIterator<string>; }
interface StringConstructor { new(value?: any): String; (value?: any): string; }
declare var String: StringConstructor;
interface Number { toFixed(digits?: number): string; toString(radix?: number): string; valueOf(): number; }
interface NumberConstructor { new(value?: any): Number; (value?: any): number; isFinite(n: number): boolean; isInteger(n: number): boolean; isNaN(n: number): boolean; parseFloat(s: string): number; parseInt(s: string, radix?: number): number; MAX_SAFE_INTEGER: number; MIN_SAFE_INTEGER: number; }
declare var Number: NumberConstructor;
interface Boolean { valueOf(): boolean; }
interface BooleanConstructor { new(value?: any): Boolean; (value?: any): boolean; }
declare var Boolean: BooleanConstructor;
interface Object { constructor: Function; toString(): string; valueOf(): Object; hasOwnProperty(v: string): boolean; }
interface ObjectConstructor { new(value?: any): Object; keys(o: any): string[]; values(o: any): any[]; entries(o: any): [string, any][]; assign<T>(target: T, ...sources: any[]): T; freeze<T>(o: T): Readonly<T>; fromEntries(entries: Iterable<readonly [PropertyKey, any]>): any; }
declare var Object: ObjectConstructor;
interface Function { apply(thisArg: any, argArray?: any): any; call(thisArg: any, ...argArray: any[]): any; bind(thisArg: any, ...argArray: any[]): any; prototype: any; length: number; name: string; }
interface FunctionConstructor { new(...args: string[]): Function; (...args: string[]): Function; prototype: Function; }
declare var Function: FunctionConstructor;
interface CallableFunction extends Function {}
interface NewableFunction extends Function {}
interface RegExp { test(s: string): boolean; exec(s: string): RegExpExecArray | null; source: string; flags: string; global: boolean; }
interface RegExpMatchArray extends Array<string> { index?: number; input?: string; groups?: { [key: string]: string }; }
interface RegExpExecArray extends Array<string> { index: number; input: string; groups?: { [key: string]: string }; }
interface RegExpConstructor { new(pattern: string | RegExp, flags?: string): RegExp; (pattern: string | RegExp, flags?: string): RegExp; }
declare var RegExp: RegExpConstructor;
interface IArguments { [index: number]: any; length: number; callee: Function; }
interface Date { getTime(): number; toISOString(): string; toJSON(): string; toString(): string; toLocaleDateString(): string; toLocaleTimeString(): string; getFullYear(): number; getMonth(): number; getDate(): number; getHours(): number; getMinutes(): number; getSeconds(): number; getMilliseconds(): number; }
interface DateConstructor { new(): Date; new(value: number | string): Date; new(year: number, month: number, date?: number, hours?: number, minutes?: number, seconds?: number, ms?: number): Date; (): string; now(): number; parse(s: string): number; }
declare var Date: DateConstructor;
interface Error { name: string; message: string; stack?: string; }
interface ErrorConstructor { new(message?: string): Error; (message?: string): Error; prototype: Error; }
declare var Error: ErrorConstructor;
interface TypeError extends Error {}
interface TypeErrorConstructor extends ErrorConstructor { new(message?: string): TypeError; (message?: string): TypeError; }
declare var TypeError: TypeErrorConstructor;
interface RangeError extends Error {}
declare var RangeError: ErrorConstructor;
interface JSON { parse(text: string, reviver?: (key: string, value: any) => any): any; stringify(value: any, replacer?: any, space?: string | number): string; }
declare var JSON: JSON;
interface Map<K, V> { get(key: K): V | undefined; set(key: K, value: V): this; has(key: K): boolean; delete(key: K): boolean; clear(): void; size: number; forEach(fn: (value: V, key: K) => void): void; keys(): IterableIterator<K>; values(): IterableIterator<V>; entries(): IterableIterator<[K, V]>; [Symbol.iterator](): IterableIterator<[K, V]>; }
interface MapConstructor { new<K, V>(entries?: readonly (readonly [K, V])[] | null): Map<K, V>; }
declare var Map: MapConstructor;
interface Set<T> { add(value: T): this; has(value: T): boolean; delete(value: T): boolean; clear(): void; size: number; forEach(fn: (value: T) => void): void; keys(): IterableIterator<T>; values(): IterableIterator<T>; entries(): IterableIterator<[T, T]>; [Symbol.iterator](): IterableIterator<T>; }
interface SetConstructor { new<T>(values?: readonly T[] | null): Set<T>; }
declare var Set: SetConstructor;
interface WeakMap<K extends object, V> { get(key: K): V | undefined; set(key: K, value: V): this; has(key: K): boolean; delete(key: K): boolean; }
interface WeakMapConstructor { new<K extends object, V>(entries?: readonly (readonly [K, V])[] | null): WeakMap<K, V>; }
declare var WeakMap: WeakMapConstructor;
interface WeakSet<T extends object> { add(value: T): this; has(value: T): boolean; delete(value: T): boolean; }
interface WeakSetConstructor { new<T extends object>(values?: readonly T[] | null): WeakSet<T>; }
declare var WeakSet: WeakSetConstructor;
interface Promise<T> { then<R1 = T, R2 = never>(onfulfilled?: (value: T) => R1 | PromiseLike<R1>, onrejected?: (reason: any) => R2 | PromiseLike<R2>): Promise<R1 | R2>; catch<R = never>(onrejected?: (reason: any) => R | PromiseLike<R>): Promise<T | R>; finally(onfinally?: () => void): Promise<T>; }
interface PromiseLike<T> { then<R1 = T, R2 = never>(onfulfilled?: (value: T) => R1 | PromiseLike<R1>, onrejected?: (reason: any) => R2 | PromiseLike<R2>): PromiseLike<R1 | R2>; }
interface PromiseConstructor { new<T>(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: any) => void) => void): Promise<T>; resolve<T>(value: T): Promise<T>; reject<T = never>(reason?: any): Promise<T>; all<T>(values: readonly (T | PromiseLike<T>)[]): Promise<T[]>; race<T>(values: readonly (T | PromiseLike<T>)[]): Promise<T>; allSettled<T>(values: readonly (T | PromiseLike<T>)[]): Promise<PromiseSettledResult<T>[]>; }
declare var Promise: PromiseConstructor;
type PromiseSettledResult<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: any };
type Awaited<T> = T extends PromiseLike<infer U> ? Awaited<U> : T;
type Partial<T> = { [P in keyof T]?: T[P] };
type Required<T> = { [P in keyof T]-?: T[P] };
type Readonly<T> = { readonly [P in keyof T]: T[P] };
type Record<K extends keyof any, T> = { [P in K]: T };
type Pick<T, K extends keyof T> = { [P in K]: T[P] };
type Omit<T, K extends keyof any> = Pick<T, Exclude<keyof T, K>>;
type Exclude<T, U> = T extends U ? never : T;
type Extract<T, U> = T extends U ? T : never;
type NonNullable<T> = T extends null | undefined ? never : T;
type ReturnType<T extends (...args: any) => any> = T extends (...args: any) => infer R ? R : any;
type Parameters<T extends (...args: any) => any> = T extends (...args: infer P) => any ? P : never;
type ConstructorParameters<T extends abstract new (...args: any) => any> = T extends abstract new (...args: infer P) => any ? P : never;
type InstanceType<T extends abstract new (...args: any) => any> = T extends abstract new (...args: any) => infer R ? R : any;
type PropertyKey = string | number | symbol;
type Uppercase<S extends string> = intrinsic;
type Lowercase<S extends string> = intrinsic;
type Capitalize<S extends string> = intrinsic;
type Uncapitalize<S extends string> = intrinsic;
interface ArrayLike<T> { readonly length: number; readonly [n: number]: T; }
interface TemplateStringsArray extends ReadonlyArray<string> { readonly raw: readonly string[]; }
interface Iterable<T> { [Symbol.iterator](): Iterator<T>; }
interface Iterator<T> { next(): IteratorResult<T>; }
interface IteratorResult<T> { done: boolean; value: T; }
interface IterableIterator<T> extends Iterator<T> { [Symbol.iterator](): IterableIterator<T>; }
interface AsyncIterable<T> { [Symbol.asyncIterator](): AsyncIterator<T>; }
interface AsyncIterator<T> { next(): Promise<IteratorResult<T>>; }
interface AsyncIterableIterator<T> extends AsyncIterator<T> { [Symbol.asyncIterator](): AsyncIterableIterator<T>; }
interface SymbolConstructor { readonly iterator: unique symbol; readonly asyncIterator: unique symbol; readonly hasInstance: unique symbol; readonly toPrimitive: unique symbol; readonly toStringTag: unique symbol; }
declare var Symbol: SymbolConstructor;
interface Console { log(...args: any[]): void; error(...args: any[]): void; warn(...args: any[]): void; info(...args: any[]): void; debug(...args: any[]): void; }
declare var console: Console;
declare function setTimeout(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
declare function clearTimeout(id: number): void;
declare function setInterval(handler: (...args: any[]) => void, timeout?: number, ...args: any[]): number;
declare function clearInterval(id: number): void;
declare function fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
declare function atob(data: string): string;
declare function btoa(data: string): string;
declare function structuredClone<T>(value: T): T;
declare var crypto: Crypto;
interface Crypto { subtle: SubtleCrypto; getRandomValues<T extends ArrayBufferView>(array: T): T; randomUUID(): string; }
interface SubtleCrypto { digest(algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer>; }
interface TextEncoder { encode(input?: string): Uint8Array; }
interface TextEncoderConstructor { new(): TextEncoder; }
declare var TextEncoder: TextEncoderConstructor;
interface TextDecoder { decode(input?: ArrayBuffer | ArrayBufferView): string; }
interface TextDecoderConstructor { new(label?: string): TextDecoder; }
declare var TextDecoder: TextDecoderConstructor;
interface ArrayBuffer { readonly byteLength: number; slice(begin: number, end?: number): ArrayBuffer; }
interface ArrayBufferConstructor { new(byteLength: number): ArrayBuffer; isView(arg: any): boolean; }
declare var ArrayBuffer: ArrayBufferConstructor;
interface ArrayBufferView { buffer: ArrayBuffer; byteLength: number; byteOffset: number; }
interface Uint8Array { readonly length: number; readonly byteLength: number; [index: number]: number; slice(start?: number, end?: number): Uint8Array; }
interface Uint8ArrayConstructor { new(length: number): Uint8Array; new(array: ArrayLike<number>): Uint8Array; new(buffer: ArrayBuffer, byteOffset?: number, length?: number): Uint8Array; from(arrayLike: ArrayLike<number>): Uint8Array; }
declare var Uint8Array: Uint8ArrayConstructor;
interface URL { hash: string; host: string; hostname: string; href: string; origin: string; pathname: string; port: string; protocol: string; search: string; searchParams: URLSearchParams; toString(): string; }
interface URLConstructor { new(url: string, base?: string): URL; }
declare var URL: URLConstructor;
interface URLSearchParams { get(name: string): string | null; set(name: string, value: string): void; has(name: string): boolean; delete(name: string): void; append(name: string, value: string): void; toString(): string; entries(): IterableIterator<[string, string]>; keys(): IterableIterator<string>; values(): IterableIterator<string>; forEach(fn: (value: string, key: string) => void): void; [Symbol.iterator](): IterableIterator<[string, string]>; }
interface URLSearchParamsConstructor { new(init?: string | Record<string, string> | [string, string][]): URLSearchParams; }
declare var URLSearchParams: URLSearchParamsConstructor;
interface Headers { get(name: string): string | null; set(name: string, value: string): void; has(name: string): boolean; delete(name: string): void; append(name: string, value: string): void; forEach(fn: (value: string, key: string) => void): void; entries(): IterableIterator<[string, string]>; keys(): IterableIterator<string>; values(): IterableIterator<string>; }
interface HeadersConstructor { new(init?: Record<string, string> | [string, string][]): Headers; }
declare var Headers: HeadersConstructor;
type RequestInfo = string | Request;
interface RequestInit { method?: string; headers?: Record<string, string> | Headers; body?: string | ArrayBuffer | ReadableStream | null; redirect?: string; signal?: AbortSignal; }
interface Request { url: string; method: string; headers: Headers; body: ReadableStream | null; json(): Promise<any>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; clone(): Request; signal: AbortSignal; }
interface RequestConstructor { new(input: RequestInfo | URL, init?: RequestInit): Request; }
declare var Request: RequestConstructor;
interface ResponseInit { status?: number; statusText?: string; headers?: Record<string, string> | Headers; }
interface Response { ok: boolean; status: number; statusText: string; headers: Headers; body: ReadableStream | null; json(): Promise<any>; text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer>; clone(): Response; }
interface ResponseConstructor { new(body?: string | ArrayBuffer | ReadableStream | null, init?: ResponseInit): Response; json(data: any, init?: ResponseInit): Response; redirect(url: string, status?: number): Response; }
declare var Response: ResponseConstructor;
interface ReadableStream<R = any> { getReader(): ReadableStreamDefaultReader<R>; pipeThrough<T>(transform: { writable: WritableStream<R>; readable: ReadableStream<T> }): ReadableStream<T>; pipeTo(dest: WritableStream<R>): Promise<void>; cancel(reason?: any): Promise<void>; }
interface ReadableStreamDefaultReader<R = any> { read(): Promise<{ done: boolean; value: R }>; cancel(reason?: any): Promise<void>; releaseLock(): void; }
interface WritableStream<W = any> { getWriter(): WritableStreamDefaultWriter<W>; }
interface WritableStreamDefaultWriter<W = any> { write(chunk: W): Promise<void>; close(): Promise<void>; abort(reason?: any): Promise<void>; releaseLock(): void; }
interface TransformStream<I = any, O = any> { readable: ReadableStream<O>; writable: WritableStream<I>; }
interface AbortSignal { readonly aborted: boolean; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void; }
interface AbortController { readonly signal: AbortSignal; abort(): void; }
interface AbortControllerConstructor { new(): AbortController; }
declare var AbortController: AbortControllerConstructor;
interface EventTarget { addEventListener(type: string, listener: (event: any) => void): void; removeEventListener(type: string, listener: (event: any) => void): void; dispatchEvent(event: any): boolean; }
declare var Math: { abs(x: number): number; ceil(x: number): number; floor(x: number): number; max(...values: number[]): number; min(...values: number[]): number; pow(x: number, y: number): number; random(): number; round(x: number): number; sqrt(x: number): number; trunc(x: number): number; log(x: number): number; log2(x: number): number; log10(x: number): number; sign(x: number): number; PI: number; E: number; };
declare var parseInt: (s: string, radix?: number) => number;
declare var parseFloat: (s: string) => number;
declare var isNaN: (n: number) => boolean;
declare var isFinite: (n: number) => boolean;
declare var NaN: number;
declare var Infinity: number;
declare var undefined: undefined;
declare function encodeURIComponent(str: string): string;
declare function decodeURIComponent(str: string): string;
declare function encodeURI(str: string): string;
declare function decodeURI(str: string): string;

// Workers-specific globals
interface ExecutionContext { waitUntil(promise: Promise<any>): void; passThroughOnException(): void; }
interface ExportedHandler<Env = unknown> { fetch?(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response; scheduled?(event: any, env: Env, ctx: ExecutionContext): Promise<void> | void; }
interface KVNamespace { get(key: string, options?: any): Promise<string | null>; put(key: string, value: string, options?: any): Promise<void>; delete(key: string): Promise<void>; list(options?: any): Promise<any>; }
interface DurableObjectNamespace { get(id: DurableObjectId): DurableObjectStub; idFromName(name: string): DurableObjectId; idFromString(id: string): DurableObjectId; newUniqueId(): DurableObjectId; }
interface DurableObjectId { toString(): string; }
interface DurableObjectStub { fetch(input: RequestInfo, init?: RequestInit): Promise<Response>; }
interface D1Database { prepare(query: string): D1PreparedStatement; batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]>; exec(query: string): Promise<D1ExecResult>; dump(): Promise<ArrayBuffer>; }
interface D1PreparedStatement { bind(...values: any[]): D1PreparedStatement; first<T = unknown>(colName?: string): Promise<T | null>; run<T = unknown>(): Promise<D1Result<T>>; all<T = unknown>(): Promise<D1Result<T>>; raw<T = unknown>(): Promise<T[]>; }
interface D1Result<T = unknown> { results: T[]; success: boolean; meta: any; }
interface D1ExecResult { count: number; duration: number; }
interface R2Bucket { get(key: string): Promise<R2ObjectBody | null>; put(key: string, value: string | ArrayBuffer | ReadableStream, options?: any): Promise<R2Object>; delete(key: string): Promise<void>; list(options?: any): Promise<R2Objects>; head(key: string): Promise<R2Object | null>; }
interface R2Object { key: string; size: number; etag: string; httpMetadata?: any; customMetadata?: Record<string, string>; }
interface R2ObjectBody extends R2Object { body: ReadableStream; text(): Promise<string>; json<T>(): Promise<T>; arrayBuffer(): Promise<ArrayBuffer>; }
interface R2Objects { objects: R2Object[]; truncated: boolean; cursor?: string; delimitedPrefixes: string[]; }
`;
