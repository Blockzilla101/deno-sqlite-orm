Sqlite ORM for deno. Tables with relations are not supported.

#### Usage
**Create an instance of the ORM:**
```typescript
import { SqliteOrm, SqlTable } from 'https://deno.land/x/deno_sqlite_orm@1.0.0/mod.ts';
const orm = new SqliteOrm({
    dbPath: 'path/to/database.db'
});
```
You can access the database instance directly by `orm.db`. If you are using an existing database and it contains JSON objects, enable `jsonCompatMode` in options or objects similar to following will not be parsed.
```json
{
    "foo": "baz",
    "bar": 0
}
```

**Create a model:**<br>
Use the `@orm.model()` decorator for creating a new model. After all models are loaded, call `orm.modelsLoaded()`
```typescript
@orm.model()
class Foo extends SqlTable {

}
orm.modelsLoaded()
```
Incase `Foo` exists in the database but has a different name, use `@orm.model('bar')`. All Tables have `id` as a primary key. 
It can be removed by overriding it and using `@orm.ignoreColumn()`. Tables are created if they don't exist. If new columns 
are added, the table is altered. If a column is removed from the model, it still stays in the database. If you want to rename the property, or the column exists with a different name use `@orm.mappedTo('oldName')`

**Defining columns:**<br>
All properties of the table are considered as columns. Column types are automatically inferred from the default value<br>
of the property.
```typescript
class Foo extends SqlTable {
@orm.model()
class Foo extends SqlTable {
  // type is automatically inferred as "string"
  public foo = 'bar'

  // column type is required when property doesn't have a default value
  @orm.columnType('string')
  public bar!: string

  // set a column as a primary key
  @orm.primaryKey()
  public fooId = 0

  // ignore property
  @orm.ignoreColumn()
  @orm.autoIncrement() // mark it as autoincrement
  public ignored = 0
  
  // remove id from primary key
  @orm.ignoreColumn()
  public id = -1

  // automatically marked as nullable
  @orm.columnType('string')
  @orm.nullable() // or manually mark it
  public baz: string | null = null

  // incase the column exists with a different name
  @orm.mappedTo('bar')
  public baa = ''

  // if you don't want to stack multiple decorators, you can do:
  @orm.column({ type: 'string', nullable: true })
  public faz!: string | null
}
```
**Querying data:**
```typescript
// find a single a row, throws an error (`DBNotFound`) when not found
orm.findOne(Foo, 1) // finds a row in Foo where id = 1
// equivalent to above
orm.findOne(Foo, {
  where: {
    clause: 'id = ?',
    values: [1] // optional when not using placeholders
  }
})

// same usage as above, but returns a new instance of `Foo` when not found
// you can check if its new from `Foo._new`
orm.findOneOptional(Foo, 1)

// same as `findOne` but returns multiple instances of or rows of Foo
orm.findMany(Foo, {
  where: {
    clause: 'id > 5'
  },
  limit: 10, // optional
  offset: 3 // optional
})

// save an instance of Foo
const baz = new Foo()
orm.save(baz)

// delete rows from Foo where id = 1
orm.delete(Foo, {
  where: {
    clause: 'id = 1'
  }
})

// count rows of Foo where id < 5
orm.countWhere(Foo, {
  where: {
    clause: 'id < 5'
  }
})

// or you can do a more advanced count
orm.aggregateSelect<[foo: string, count: number]>(Foo, {
  select: {
    clause: 'foo, COUNT(baz)'
  },
  group: {
    cols: ['foo']
  }
})
```

**Saving objects:**<br>
Objects are converted to JSON before saving, and parsed when read. If its a class instance then the class should be registered
by `@registerJsonSerializable()`
```typescript
import { registerJsonSerializable } from 'https://deno.land/x/deno_sqlite_orm@1.0.0/mod.ts';

// the property "ignored" will be ignored and not saved
@registerJsonSerializable(['ignored'])
class Bar {
  public foo = 'bar'
  public ignored = ''
}

@orm.model()
class Foo extends SqlTable {
  // type is automatically inferred as json
  bar: Record<string, any> = {}
  baz: Bar = new Bar()
}
```

##### Example
```typescript
import { SqliteOrm, SqlTable } from 'https://deno.land/x/deno_sqlite_orm@1.0.0/mod.ts';
const orm = new SqliteOrm({
    dbPath: 'path/to/database.db',
});

// register the class as a table
@orm.model()
class Foo extends SqlTable {
  // type is automatically inferred
  public foo = 'baz'

  // type is required when not set
  @orm.columnType('string')
  public bar!: string

  // type is inferred as json
  public baz: Record<string, any> = {
    foo: 'foo',
    bar: 'baz'
  }
  
  // ignore this property
  @orm.ignoreColumn()
  public ignored = ''
}

orm.modelsLoaded()
const obj = new Foo()

// save the obj
orm.save(obj)

// fetch the saved obj
console.log(db.findOne(Foo, 1))

// count number of rows of `Foo` where id > 1
console.log(db.countWhere(Foo, {
  where: {
    clause: 'id > ?',
    values: [1]
  }
}))

```
