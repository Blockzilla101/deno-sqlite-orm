import { Database as SqliteDatabase, DatabaseOpenOptions } from 'sqlite-native';
import { buildAlterQuery, buildDeleteQuery, buildInsertQuery, buildModelFromData, buildSelectQuery, buildTableQuery, buildUpdateQuery, isProvidedTypeValid } from './builder.ts';

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
        query: string;
        values?: any[];
    };
}

export interface OrderClause {
    order: {
        by: string;
        desc?: boolean;
    };
}

export interface SelectQuery extends WhereClause, Partial<OrderClause> {
    limit?: number;
    offset?: number;
}

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

    constructor(options: OrmOptions) {
        this.db = new SqliteDatabase(options.dbPath, options.openOptions);
    }

    //#region table logic

    public findOne<T extends SqlTable>(table: new () => T, id: any): T {
        const col = this.models[table.name].columns.find((c) => c.isPrimaryKey);
        if (col == null) throw new Error(`${this.models[table.name].tableName} does not have primary key`);
        if (!isProvidedTypeValid(id, col)) throw new TypeError(`${this.models[table.name].tableName}.${col.name} has a different type`);

        const query = buildSelectQuery(
            {
                where: {
                    query: `${col.mappedTo ?? col.name} = ?`,
                    values: [this.serialize(id, col.type)],
                },
                limit: 1,
            },
            this.models[table.name].tableName,
        );

        const found = this.db.prepare(query.query).get(...query.params);
        if (!found) throw new Error(`row with ${col.name} = ${id} was not found in table ${table.name}`);

        const parsed = new table();
        for (const [key, value] of Object.entries(found)) {
            const columnData = this.models[table.name].columns.find((c) => c.mappedTo === key || c.name === key) as NonNullable<TableColumn>;
            (parsed as Record<string, unknown>)[columnData.name] = this.deseralize(value, columnData.type);
        }

        return parsed;
    }

    public findMany<T extends SqlTable>(table: new () => T, query: SelectQuery): T[] {
        const builtQuery = buildSelectQuery(query, this.models[table.name].tableName);

        const data = this.db.prepare(builtQuery.query).all(...builtQuery.params);
        const parsedAll: T[] = [];

        for (const datum of data) {
            const parsed = new table();
            for (const [key, value] of Object.entries(datum)) {
                const columnData = this.models[table.name].columns.find((c) => c.mappedTo === key || c.name === key) as NonNullable<TableColumn>;
                (parsed as Record<string, unknown>)[columnData.name] = this.deseralize(value, columnData.type);
            }
            parsedAll.push(parsed);
        }

        return parsedAll;
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
            if (data.isPrimaryKey && this.tempModelData.find((i) => i.isPrimaryKey)) throw new TypeError(`${model.constructor.name}: table cannot have two primary keys, existing key (${this.tempModelData.find((i) => i.isPrimaryKey)})`);
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
                if (v == null && this.tempModelData.find((i) => i.name === k) == null) throw new TypeError(`${tableName ?? model.name}.${k}: Cannot infer type from a null value property`);

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
        };
    }

    //#endregion decorators

    private createTempColumn(data: Partial<TableColumn>, model: SqlTable & Record<string, any>, propertyKey: string) {
        const index = this.tempModelData.findIndex((i) => i.name == propertyKey);
        if (index > -1) {
            Object.assign(this.tempModelData[index], data);
            return;
        }

        if (typeof model[propertyKey] !== 'string' && typeof model[propertyKey] !== 'boolean' && typeof model[propertyKey] !== 'number' && typeof model[propertyKey] !== 'object' && model[propertyKey] != null) throw new Error(`${model.constructor.name}.${propertyKey} has an invalid type, (${typeof model[propertyKey]} is not valid)`);

        data.name = propertyKey;
        data.defaultValue = model[propertyKey];

        if (data.type == null) {
            if (model[propertyKey] == null) throw new Error(`${model.constructor.name}.${propertyKey}: type must be specified for a column with null value`);
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
        // fixme: implement
        if (data == null) return null;
        return data;
    }

    private deseralize(data: any, type: ColumnType) {
        // fixme: implement
        return data;
    }
}
