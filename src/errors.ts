export class DBError extends Error {}

export class DBNotFound extends DBError {}
export class DBInvalidTable extends DBError {}
