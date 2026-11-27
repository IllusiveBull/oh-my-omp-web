/** A field of a decoded JSON object; `unknown` until the caller has checked it. */
export const field = (object: object, key: string): unknown => Reflect.get(object, key);
