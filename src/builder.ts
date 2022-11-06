import { SqlTable } from '../mod.ts';
import { jsonify } from './json.ts';
import { ColumnType, Model, TableColumn } from '/orm.ts';

function getSqlType(type: ColumnType) {
    switch (type) {
        case 'boolean':
        case 'integer':
            return 'INTEGER';
        case 'json':
        case 'string':
            return 'TEXT';
        case 'blob':
            return 'BLOB';
        default:
            throw new Error('invalid column type');
    }
}

function getDefaultValue(type: ColumnType, value: any) {
    switch (type) {
        case 'boolean':
            return value ? 1 : 0;
        case 'integer':
            return value;
        case 'json':
            return `'${jsonify(value)}'`;
        case 'string':
            return `'${value}'`;
        case 'blob':
            return value;
        default:
            throw new Error('invalid column type');
    }
}

export function buildTableQuery(model: Model) {
    const str = [`CREATE TABLE '${model.tableName}' (`];
    for (const column of model.columns) {
        str.push(buildColumnQuery(column) + ',');
    }
    str[str.length - 1] = str[str.length - 1].slice(0, -1);
    str.push(')');

    return str.join('\n');
}

export function buildColumnQuery(column: TableColumn) {
    return `${column.name} ${getSqlType(column.type)} ${column.nullable ? '' : 'NOT NULL'} ${column.defaultValue == null ? '' : 'DEFAULT ' + getDefaultValue(column.type, column.defaultValue)} ${column.isPrimaryKey ? 'PRIMARY KEY' : ''}`;
}

export function buildAlterQuery(existingModel: Model, actualModel: Model) {
    if (existingModel.tableName !== actualModel.tableName) throw new Error('table names are different');
    return actualModel.columns
        .filter((col) => existingModel.columns.find((c) => c.name === col.name || c.name === col.mappedTo) == null)
        .map((col) => `ALTER TABLE '${actualModel.tableName}' ADD COLUMN ${buildColumnQuery(col)}`);
}

export function buildModelFromData(ogModel: Model, data: any[]): Model {
    const cols: TableColumn[] = [];

    for (const datum of data) {
        const ogCol = ogModel.columns.find((t) => t.name === datum.name || t.mappedTo === datum.name);
        if (ogCol == null) continue;

        cols.push({
            defaultValue: datum.dflt_value,
            name: datum.name,
            nullable: datum.notnull == 0,
            type: ogCol.type,
            isPrimaryKey: datum.pk == 0,
            mappedTo: ogCol.mappedTo,
        });
    }

    return new Model(ogModel.tableName, cols);
}
