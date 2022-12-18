import { Database as SqliteDatabase, DatabaseOpenOptions } from 'https://deno.land/x/sqlite3@0.6.1/mod.ts';
import { buildAggregateQuery, buildAlterQuery, buildCountWhereQuery, buildDeleteQuery, buildInsertQuery, buildModelFromData, buildSelectQuery, buildTableQuery, buildUpdateQuery, isProvidedTypeValid } from './builder.ts';
import { DBInvalidData, DBInvalidTable, DBNotFound } from './errors.ts';
import { dejsonify, jsonify } from './json.ts';

interface OrmOptions {
    dbPath: string;
    openOptions?: DatabaseOpenOptions;
    backupDir?: string;
    backupInterval?: number;
}

export type ColumnType = 'string' | 'number' | 'boolean' | 'json' | 'integer' | 'blob';

export class SqlTable {
    public _new = true;
    public id = -1;
}

export interface TableColumn {
    type: ColumnType;
    name: string;
    mappedTo?: string;
    nullable: boolean;
    defaultValue: any;
    isPrimaryKey: boolean;
    autoIncrement: boolean;
}

export interface WhereClause {
    where: {
        clause: string;
        values?: any[];
    };
}

export interface OrderClause {
    order: {
        by: string;
        desc?: boolean;
    };
}

export interface AggregateClause {
    select: {
        clause: string;
    };
}

export interface GroupByClause {
    group: {
        cols: string[];
    };
}

export interface HavingClause {
    having: {
        clause: string;
        values?: any[];
    };
}

export interface SelectQuery extends Partial<WhereClause>, Partial<OrderClause> {
    limit?: number;
    offset?: number;
}

export interface AggregateSelectQuery extends SelectQuery, AggregateClause, GroupByClause, Partial<HavingClause> {
}

export type PrimitiveTypes = number | string | boolean;

// delete doesn't require a where clause
export type DeleteQuery = Partial<SelectQuery>;

export class Model {
    constructor(public tableName: string, public columns: TableColumn[]) {}
}

export class SqliteOrm {
    public db: SqliteDatabase;
    private hasChanges = false;

    public models: Record<string, Model> = {};
    private tempModelData: TableColumn[] = [];
    private ignoredColumns: string[] = [];

    private opts: OrmOptions;
    private lastModel: Record<string, Model> = {};

    constructor(options: OrmOptions) {
        this.opts = options;

        SqliteOrm.logInfo(this.opts, 'opening database');

        this.db = new SqliteDatabase(options.dbPath, options.openOptions);
        try {
            this.lastModel = JSON.parse(Deno.readTextFileSync(`${options.dbPath}.model.json`));
        } catch (_e) {
            this.lastModel = {};
        }
    }

    //#region table logic

    public findOne<T extends SqlTable>(table: new () => T, idOrQuery: PrimitiveTypes | SelectQuery): T {
        const col = this.models[table.name].columns.find((c) => c.isPrimaryKey);
        if (col == null) throw new DBInvalidTable(`${this.models[table.name].tableName} does not have primary key`);
        if (typeof idOrQuery !== 'object' && !isProvidedTypeValid(idOrQuery, col)) throw new DBInvalidData(`${this.models[table.name].tableName}.${col.name} has a different type`);

        const query = buildSelectQuery(
            typeof idOrQuery === 'object' ? { ...idOrQuery, limit: 1 } : {
                where: {
                    clause: `${col.mappedTo ?? col.name} = ?`,
                    values: [this.serialize(idOrQuery, col.type)],
                },
                limit: 1,
            },
            this.models[table.name].tableName,
        );

        const found = this.db.prepare(query.query).get(...query.params);
        if (!found) {
            if (typeof idOrQuery === 'object') {
                throw new DBNotFound(`query did not match any items in ${table.name}`);
            } else {
                throw new DBNotFound(`row with ${col.name} = ${idOrQuery} was not found in table ${table.name}`);
            }
        }

        const parsed = new table();
        for (const col of this.models[table.name].columns) {
            (parsed as Record<string, unknown>)[col.name] = this.deseralize(found[col.mappedTo ?? col.name], col.type);
        }

        return parsed;
    }

    public findOneOptional<T extends SqlTable>(table: new () => T, idOrQuery: PrimitiveTypes | SelectQuery): T {
        try {
            return this.findOne(table, idOrQuery);
        } catch (e) {
            if (e instanceof DBNotFound) {
                return new table();
            }
            throw e;
        }
    }

    public findMany<T extends SqlTable>(table: new () => T, query: SelectQuery): T[] {
        const builtQuery = buildSelectQuery(query, this.models[table.name].tableName);

        const data = this.db.prepare(builtQuery.query).all(...builtQuery.params);
        const parsedAll: T[] = [];

        for (const datum of data) {
            const parsed = new table();
            for (const col of this.models[table.name].columns) {
                (parsed as Record<string, unknown>)[col.name] = this.deseralize(datum[col.mappedTo ?? col.name], col.type);
            }
            parsedAll.push(parsed);
        }

        return parsedAll;
    }

    public countWhere<T extends SqlTable>(table: new () => T, query: WhereClause): number {
        const builtQuery = buildCountWhereQuery(query, this.models[table.name].tableName);
        return this.db.prepare(builtQuery.query).get<{ 'COUNT(*)': number }>(...builtQuery.params)!['COUNT(*)'];
    }

    public aggregateSelect<Row extends Array<any>, T extends SqlTable = SqlTable>(table: new () => T, query: AggregateSelectQuery): Row[] {
        const builtQuery = buildAggregateQuery(query, this.models[table.name].tableName);
        return this.db.prepare(builtQuery.query).values(...builtQuery.params);
    }

    public save<T extends SqlTable>(table: T): T {
        const model = this.models[table.constructor.name];

        const builtData: Record<string, unknown> = {};
        model.columns.forEach((col) => {
            builtData[col.mappedTo ?? col.name] = this.serialize((table as Record<string, unknown>)[col.name], col.type);
        });

        if (table._new) {
            const builtQuery = buildInsertQuery(model, builtData);
            this.db.exec(builtQuery.query, ...builtQuery.params);

            const incrementPrimaryKey = model.columns.find((c) => c.isPrimaryKey && c.autoIncrement);
            if (incrementPrimaryKey) {
                (table as Record<string, unknown>)[incrementPrimaryKey.name] = this.db.lastInsertRowId;
            }

            table._new = false;
        } else {
            const builtQuery = buildUpdateQuery(model, builtData);
            this.db.exec(builtQuery.query, ...builtQuery.params);
        }

        return table;
    }

    public delete<T extends SqlTable>(table: new () => T, query: DeleteQuery) {
        const built = buildDeleteQuery(query, this.models[table.name].tableName);
        this.db.exec(built.query, ...built.params);
    }

    //#endregion table logic

    //#region decorators

    /**
     * Explicity set column type for a model otherwised inferred from default value.
     * @param type type of table column
     * @param nullable whether column can have a null value, defaults to true when property value is `undefined` or `null`
     */
    public column(data: Partial<TableColumn>) {
        return (model: { constructor: new () => SqlTable } | SqlTable, propertyKey: string) => {
            if (data.isPrimaryKey && this.tempModelData.find((i) => i.isPrimaryKey)) throw new DBInvalidTable(`${model.constructor.name}: table cannot have two primary keys, existing key (${this.tempModelData.find((i) => i.isPrimaryKey)})`);
            this.createTempColumn(data, new (model as { constructor: new () => SqlTable }).constructor(), propertyKey);
        };
    }

    /**
     * Sets type of data the column has.
     * @param type column data type
     */
    public columnType(type: ColumnType) {
        return this.column({ type });
    }

    /**
     * Marks a column as nullable.
     */
    public nullable(nullable = true) {
        return this.column({ nullable });
    }

    /**
     * Marks a column as primary key
     */
    public primaryKey(primaryKey = true) {
        return this.column({
            isPrimaryKey: primaryKey,
        });
    }

    /**
     * Maps property to an existing column.
     * @param oldColumnName name of existing column
     */
    public mapTo(mappedTo: string) {
        return this.column({
            mappedTo,
        });
    }

    /**
     * Maps property to an existing column.
     * @param oldColumnName name of existing column
     */
    public autoIncrement(autoIncrement: boolean) {
        return this.column({
            autoIncrement,
        });
    }

    /**
     * Property is not considered a column.
     */
    public ignoreColumn() {
        return (_model: SqlTable, propertyKey: string) => {
            const index = this.tempModelData.findIndex((i) => i.name === propertyKey);
            if (index > -1) {
                this.tempModelData.splice(index, 1);
            }
            this.ignoredColumns.push(propertyKey);
        };
    }

    /**
     * Adds a class to orm models.
     * @param tableName name of table in database
     */
    public model(tableName?: string) {
        return (model: new () => SqlTable) => {
            const tempModel = new model();
            const hasPrimaryKey = this.tempModelData.find((i) => i.isPrimaryKey) != null;

            for (const [k, v] of Object.entries(tempModel)) {
                if (this.ignoredColumns.includes(k)) continue;
                if (v == null && this.tempModelData.find((i) => i.name === k) == null) throw new DBInvalidTable(`${tableName ?? model.name}.${k}: Cannot infer type from a null value property`);

                // ignore types other then string, number, boolean or object
                if (typeof v !== 'string' && typeof v !== 'boolean' && typeof v !== 'object' && typeof v !== 'number') continue;

                if (hasPrimaryKey && k === 'id') continue;
                if (k.startsWith('_')) continue;

                this.createTempColumn(
                    {
                        defaultValue: v,
                        nullable: v == null,
                        name: k,
                        type: (typeof v === 'object' ? 'json' : (k === 'id' ? 'integer' : typeof v)) as ColumnType,
                        isPrimaryKey: !hasPrimaryKey && k === 'id',
                        autoIncrement: k === 'id' && !hasPrimaryKey,
                    },
                    tempModel,
                    k,
                );
            }

            const builtModel = new Model(tableName ?? model.name, this.tempModelData);
            this.models[model.name] = builtModel;
            this.tempModelData = [];

            // create table if it doesnt exist
            const info = this.db.prepare(`PRAGMA table_info('${model.name}')`).all();
            if (info.length === 0) {
                this.db.exec(buildTableQuery(builtModel));
            } else {
                // add missing columns
                const info = this.db.prepare(`PRAGMA table_info('${model.name}')`).all();
                buildAlterQuery(buildModelFromData(builtModel, info), builtModel).forEach((c) => {
                    this.db.exec(c);
                });
            }

            if (this.lastModel[model.name] == null) {
                SqliteOrm.logInfo(this.opts, `found new table ${model.name}`);
                this.saveModel();
            } else {
                const removed = this.lastModel[model.name].columns
                    .filter((c) => builtModel.columns.find((b) => (b.mappedTo ?? b.name) === (c.mappedTo ?? c.name)) == null);

                const newCols = builtModel.columns
                    .filter((c) => this.lastModel[model.name].columns.find((b) => (b.mappedTo ?? b.name) === (c.mappedTo ?? c.name)) == null);

                if (removed.length > 0) {
                    SqliteOrm.logInfo(this.opts, `[${model.name}] found ${removed.length} removed column(s) (${removed.map((c) => c.name).join(', ')})`);
                }

                if (newCols.length > 0) {
                    SqliteOrm.logInfo(this.opts, `[${model.name}] found ${newCols.length} new column(s) (${newCols.map((c) => c.name).join(', ')})`);
                }

                // todo: log column data type differences

                this.saveModel();
            }
        };
    }

    //#region logging

    public static logInfo: (dbOptions: OrmOptions, ...msg: any[]) => void = () => {
    };

    public static logDebug: (dbOptions: OrmOptions, ...msg: any[]) => void = () => {
    };

    //#endregion logging

    //#endregion decorators

    private createTempColumn(data: Partial<TableColumn>, model: SqlTable & Record<string, any>, propertyKey: string) {
        const index = this.tempModelData.findIndex((i) => i.name == propertyKey);
        if (index > -1) {
            Object.assign(this.tempModelData[index], data);
            return;
        }

        if (typeof model[propertyKey] !== 'string' && typeof model[propertyKey] !== 'boolean' && typeof model[propertyKey] !== 'number' && typeof model[propertyKey] !== 'object' && model[propertyKey] != null) throw new DBInvalidTable(`${model.constructor.name}.${propertyKey} has an invalid type, (${typeof model[propertyKey]} is not valid)`);

        data.name = propertyKey;
        data.defaultValue = model[propertyKey];

        if (data.type == null) {
            if (model[propertyKey] == null) throw new DBInvalidTable(`${model.constructor.name}.${propertyKey}: type must be specified for a column with null value`);
            data.type = typeof model[propertyKey] == 'object' ? 'json' : typeof model[propertyKey] as ColumnType;
        }

        if (data.isPrimaryKey == null && !this.tempModelData.find((i) => i.isPrimaryKey) && data.name === 'id') {
            data.isPrimaryKey = true;
        } else if (data.isPrimaryKey == null) {
            data.isPrimaryKey = false;
        }

        if (data.nullable == null && model[propertyKey] == null) {
            data.nullable = true;
        }

        if (data.autoIncrement == null) {
            data.autoIncrement = false;
        }

        this.tempModelData.push(data as Required<TableColumn>);
    }

    private serialize(data: any, type: ColumnType) {
        if (data == null) return null;
        switch (type) {
            case 'boolean': {
                if (typeof data !== 'boolean') throw new DBInvalidData('Cannot store a non boolean type on a boolean column');
                return data ? 1 : 0;
            }
            case 'string': {
                if (typeof data !== 'string') throw new DBInvalidData('Cannot store a non string type on a string column');
                return data;
            }
            case 'number': {
                if (typeof data !== 'number') throw new DBInvalidData('Cannot store a non number type on a number column');
                return data;
            }
            case 'integer': {
                if (typeof data !== 'number' || Number.isInteger(data)) throw new DBInvalidData('Cannot store a non integer type on an integer column');
                return data;
            }
            case 'blob': {
                if (!(data instanceof Uint8Array)) throw new DBInvalidData('Cannot store a blob/u8int[] type on a blob column');
                return data;
            }
            case 'json': {
                if (typeof data !== 'object') throw new DBInvalidData('Cannot convert non object type into JSON');
                return JSON.stringify(jsonify(data));
            }
            default: {
                throw new Error(`Unknown column type: ${type}`);
            }
        }
    }

    private deseralize(data: any, type: ColumnType) {
        if (data == null) return null;
        switch (type) {
            case 'boolean': {
                if (typeof data !== 'number' && !Number.isInteger(data)) throw new DBInvalidData(`Column contains ${data} instead of a boolean`);
                return data === 1 ? true : false;
            }
            case 'string': {
                if (typeof data !== 'string') throw new DBInvalidData(`Column contains ${data} instead of a string`);
                return data;
            }
            case 'number': {
                if (typeof data !== 'number') throw new DBInvalidData(`Column contains ${data} instead of a number`);
                return data;
            }
            case 'integer': {
                if (typeof data !== 'number' && !Number.isInteger(data)) throw new DBInvalidData(`Column contains ${data} instead of an integer`);
                return data;
            }
            case 'blob': {
                if (!(data instanceof Uint8Array)) throw new DBInvalidData(`Column contains ${typeof data} instead of a blob`);
                return data;
            }
            case 'json': {
                if (typeof data !== 'string') throw new DBInvalidData(`Column contains ${typeof data} instead of a JSON string`);
                try {
                    const parsed = JSON.parse(data);
                    return dejsonify(parsed);
                } catch (e) {
                    throw new DBInvalidData('Column contains invalid JSON data', { cause: e });
                }
            }
        }
    }

    private saveModel() {
        Deno.writeTextFileSync(`${this.opts.dbPath}.model.json`, JSON.stringify(this.models, null, 2));
    }
}
