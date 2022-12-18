const serializableClasses: {
    classRef: new () => any;
    ignoredProps: string[];
}[] = [];

export function registerJsonSerializabe(ignoredProps: string[]) {
    return (clas: new () => any) => {
        serializableClasses.push({
            classRef: clas,
            ignoredProps: ignoredProps,
        });
    };
}

function isSerializabe(obj: any): boolean {
    return typeof obj !== 'bigint' && typeof obj !== 'function' && typeof obj !== 'symbol';
}

function writeValue(val: any) {
    switch (typeof val) {
        case 'boolean':
            return val;
        case 'number':
            return val;
        case 'string':
            return val;
        case 'object': {
            if (val instanceof Map) {
                return {
                    data: jsonify([...val.entries()]),
                    type: 'Map',
                };
            }

            if (val instanceof Array) {
                return jsonify(val);
            }

            if (val instanceof Uint8Array) {
                return {
                    data: 'base64', // fixme
                    type: 'U8IntArray',
                };
            }

            const clas = serializableClasses.find((c) => val instanceof c.classRef);
            if (clas != null) {
                return {
                    data: jsonify(val, clas.ignoredProps),
                    type: `custom-${clas.classRef.name}`,
                };
            }

            return {
                data: jsonify(val),
                type: 'unknown',
            };
        }
        default:
            throw new Error(`Cannot write object of type ${typeof val}`);
    }
}

function readValue(val: any) {
    switch (typeof val) {
        case 'boolean':
            return val;
        case 'number':
            return val;
        case 'string':
            return val;
        case 'object': {
            if (val instanceof Array) {
                return dejsonify(val);
            }

            if (val.type === 'Map') {
                return new Map(dejsonify([val.data]));
            }

            if (val.type === 'U8IntArray') {
                return []; // fixme parse base64
            }

            if (val.type.startsWith('custom-')) {
                const clas = serializableClasses.find((c) => c.classRef.name === val.type.slice('custom-'.length));
                if (clas != null) {
                    const obj = new clas.classRef();
                    Object.assign(obj, dejsonify(val.data));
                    return obj;
                }
            }

            if (val.type === 'unknown') {
                return dejsonify(val.data);
            }

            throw new Error(`Unknown object type: ${val.type}`);
        }
        default:
            throw new Error(`Cannot read object of type ${typeof val}`);
    }
}

/**
 * @param obj Object to convert to JSON
 * @returns JSON safe object
 */
export function jsonify(obj: Record<string, any> | any[], ignoredProps: string[] = []): any {
    // parse arrays
    if (obj instanceof Array) {
        const parsed: any[] = [];
        for (const item of obj) {
            if (!isSerializabe(item)) continue;
            parsed.push(writeValue(item));
        }
        return parsed;
    }

    // parse objects
    const parsed: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
        if (!isSerializabe(value)) continue;
        if (ignoredProps.includes(key)) continue;
        parsed[key] = writeValue(value);
    }

    return parsed;
}

/**
 * @param json JSON safe object
 * @returns object before serializing
 */
export function dejsonify(jsonObj: Record<string, any> | any[]): any {
    if (jsonObj instanceof Array) {
        const parsed: any[] = [];
        for (const item of jsonObj) {
            parsed.push(readValue(item));
        }
        return parsed;
    }

    // parse objects
    const parsed: Record<string, any> = {};
    for (const [key, value] of Object.entries(jsonObj)) {
        parsed[key] = readValue(value);
    }

    return parsed;
}
