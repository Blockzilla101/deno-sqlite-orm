import { Database as SqliteDatabase, DatabaseOpenOptions } from 'sqlite-native';
import { buildAlterQuery, buildModelFromData, buildTableQuery } from './builder.ts';

interface OrmOptions {
    dbPath: string;
    openOptions?: DatabaseOpenOptions;
    backupDir?: string;
    backupInterval?: number;
}

export type ColumnType = 'string' | 'number' | 'boolean' | 'json' | 'integer' | 'blob';

export class SqlTable {
    public id: number = -1;
}

export interface TableColumn {
    type: ColumnType;
    name: string;
    mappedTo?: string;
    nullable: boolean;
    defaultValue: any;
    isPrimaryKey: boolean;
}

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

    /**
     * Explicity set column type for a model otherwised inferred from default value.
     * @param type type of table column
     * @param nullable whether column can have a null value, defaults to true when property value is `undefined` or `null`
     */
    public column(type?: ColumnType, nullable?: boolean, isPrimaryKey?: boolean, mappedTo?: string) {
        return (model: SqlTable, propertyKey: string) => {
            if (isPrimaryKey && this.tempModelData.find((i) => i.isPrimaryKey)) throw new Error('model already has a primary key');
            this.createTempColumn(
                {
                    type,
                    isPrimaryKey,
                    mappedTo,
                    nullable,
                },
                model,
                propertyKey,
            );
        };
    }

    //#region decorators

    /**
     * Sets type of data the column has.
     * @param type column data type
     */
    public columnType(type: ColumnType) {
        return this.column(type, undefined, undefined, undefined);
    }

    /**
     * Marks a column as nullable.
     */
    public nullable() {
        return this.column(undefined, true, undefined, undefined);
    }

    /**
     * Marks a column as primary key
     */
    public primaryKey() {
        return this.column(undefined, undefined, true, undefined);
    }

    /**
     * Maps property to an existing column.
     * @param oldColumnName name of existing column
     */
    public mapTo(oldColumnName: string) {
        return this.column(undefined, undefined, undefined, oldColumnName);
    }

    /**
     * Property is not considered a column.
     */
    public ignoreColumn() {
        return (model: SqlTable, propertyKey: string) => {
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
                if (v == null && this.tempModelData.find((i) => i.name === k) == null) throw new Error('Cannot infer type from a null value property');

                // ignore types other then string, number, boolean or object
                if (typeof v !== 'string' && typeof v !== 'boolean' && typeof v !== 'object' && typeof v !== 'number') continue;

                if (hasPrimaryKey && k === 'id') continue;
                if (k.startsWith('_')) continue;

                this.createTempColumn(
                    {
                        defaultValue: v,
                        nullable: v == null,
                        name: k,
                        type: (typeof v === 'object' ? 'json' : typeof v) as ColumnType,
                        isPrimaryKey: !hasPrimaryKey && k === 'id',
                    },
                    tempModel,
                    k,
                );
            }

            const builtModel = new Model(tableName ?? model.name, this.tempModelData);
            this.models[tableName ?? model.name] = builtModel;
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
        const index = this.tempModelData.findIndex((i) => i.name == data.name);
        if (index > -1) {
            Object.assign(this.tempModelData[index], data);
            return;
        }

        if (typeof model[propertyKey] !== 'string' && typeof model[propertyKey] !== 'boolean' && typeof model[propertyKey] !== 'number' && typeof model[propertyKey] !== 'object' && model[propertyKey] != null) throw new Error('property has an invalid type');

        data.name = propertyKey;
        data.defaultValue = model[propertyKey];

        if (data.type == null) {
            if (model[propertyKey] == null) throw new Error('column type must be specified');
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

        this.tempModelData.push(data as Required<TableColumn>);
    }
}
