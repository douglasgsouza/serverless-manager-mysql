# Serverless Manager for MySQL

[![npm](https://img.shields.io/npm/v/serverless-manager-mysql.svg)](https://www.npmjs.com/package/serverless-manager-mysql)
[![npm](https://img.shields.io/npm/l/serverless-manager-mysql.svg)](https://www.npmjs.com/package/serverless-manager-mysql)

### Manage your mysql connections at *serverless* scale with transaction support and connection isolation.

Serverless Manager for MySQL is a wrapper for **[mysql](https://github.com/mysqljs/mysql)** Node.js module.

Serverless functions (like AWS Lambda) scale almost infinitely by creating separate instances for each concurrent user. 
The problem is that relational databases, such as MySQL, have a connection limit (`max_connections`) that can be easily reached because of 
this automatic scalability without reusing connections, in addition, the time to open and close connections on each invoke
can be a performance bottleneck.

This module facilitates the management of a MySQL connection pool for serverless scalability.

Serverless Manager for MySQL provides connection management for the `mysql` module, balancing the flexibility of a connection pool. 
This module allows you to have simultaneous and asynchronous connections in the same function, 
while controlling and releasing free connections, allowing thousands of invocations to reuse the same connection based on your configurations.

Transaction support has been improved, ensuring isolation of connections per transaction.

It will clean up zombies, enforce connection limits per user, based on amazing method of **Jeremy Daly** in [Serverless MySQL](https://github.com/jeremydaly/serverless-mysql) module.

In addition, this module provides support for use `Promises` or `async/await` to the `mysql` module.

**NOTE:** This module *should* work with any standards-based MySQL server including serverless-offline support. 
It has been tested with AWS's RDS MySQL, Aurora MySQL, Aurora Serverless and local MySQL instances.

## Basic Example

```typescript
// Import and initialize outside of your main handler
import ServerlessManagerMysql from "serverless-manager-mysql";

const pool = new ServerlessManagerMysql({
    host     : process.env.MYSQL_HOST,
    database : process.env.MYSQL_DATABASE,
    user     : process.env.MYSQL_USER,
    password : process.env.MYSQL_PASSWORD
});


// Lambda Main handler function
export const handler: Handler = async (event, context) => {
  // Run your query
  let results = await pool.query('SELECT * FROM table');

  // Run clean up connections
  await pool.flush()

  // Return the results
  return results
}
```

## Installation
```
npm install serverless-manager-mysql
```

## Requirements
- Node 8.10+
- MySQL server/cluster

## Concepts behind this module

We have no control over serverless instances, which can be started and deactivated at any time. However, we know that in Lambda it is possible to keep a variable or module outside the function's handler, which is frozen until there is a subsequent invocation or until AWS decides to kill the instance.

Ref.:
- [How To: Reuse Database Connections in AWS Lambda](https://www.jeremydaly.com/reuse-database-connections-aws-lambda)
- [Managing concurrency for a Lambda function](https://docs.aws.amazon.com/lambda/latest/dg/configuration-concurrency.html)


With that in mind, each execution container (lambda instance) can maintain the connection pool with a minimum and maximum limit of active connections.  
In addition, if desired, a flush operation can check the global usage of user connections on the database server and eliminate inactive connections.


## Improvements of this module

- Return promises for async/await.
- Support connection pool with min and max limits.
- Support transactions with connection isolation.
- Monitor active connections and disconnect if more than X% of connections are being used, maintaining a X number of keep alive connections per container.
- Support JIT connections

## How to use this module

Serverless Manager for MySQL wraps the **[mysql](https://github.com/mysqljs/mysql)** module.
It uses all the same [connection options](https://github.com/mysqljs/mysql#connection-options), 
provides a `query()` method that accepts the same arguments when [performing queries](https://github.com/mysqljs/mysql#performing-queries) 
(except the callback), and passes back the query results exactly as the `mysql` module returns them, 
but returning promises that you can use async / await.
Some features that are not used in a serverless environment have not been implemented.

We recommend that you instantiate the module that you instantiate the module **OUTSIDE** your main function handler. 
This will allow for connection reuse between executions. 
The module must be instantiated before its methods are available. [Configuration options](#configuration-options) can only be passed
in during class instantiation.

```typscript
// Import and initialize outside of your main handler
import ServerlessManagerMysql from "serverless-manager-mysql";

// create instance of module
const pool = new ServerlessManagerMysql(poolOptions, managerOptions);
```

MySQL [connection options](https://github.com/mysqljs/mysql#connection-options) and [Pool Options](https://github.com/mysqljs/mysql#pool-options) must be passed in at initialization in the first argument.

```typscript
const pool = new ServerlessManagerMysql({
    host     : process.env.MYSQL_HOST,
    database : process.env.MYSQL_DATABASE,
    user     : process.env.MYSQL_USER,
    password : process.env.MYSQL_PASSWORD,
    connectionLimit: 10,
    waitForConnections: false
});
```

Manager [Configuration options](#configuration-options) can be passed in second argument and is optional.

```typscript
const pool = new ServerlessManagerMysql({
    host     : process.env.MYSQL_HOST,
    database : process.env.MYSQL_DATABASE,
    user     : process.env.MYSQL_USER,
    password : process.env.MYSQL_PASSWORD,
    connectionLimit: 10,
    waitForConnections: false
}, {
    maxKeepAliveConnPerPool: 2,
    maxRetries: 10,
    retryDelay: 100,
    killZombies: true,
    debug: true
});
```

You can explicitly get a connection from the pool using the `getConnection()` method if you want to, though it isn't necessary. 
This method returns a promise, so you'll need to `await` the response or wrap it in a promise chain.

```typscript
const conn = await db.getConnection();
```

Running queries is super simple using the `query()` method. 
It supports all [query options](https://github.com/mysqljs/mysql#performing-queries) supported by the `mysql` module, 
but returns a promise instead of using the standard callbacks. 
You either need to `await` them or wrap them in a promise chain.

```typscript
// Simple query
let results = await pool.query('SELECT * FROM mytable');

// Query with placeholder values
let results = await pool.query('SELECT * FROM mytable WHERE title = ?', ['lambda']);

// Query with advanced options
let results = await pool.query({
  sql: 'SELECT * FROM mytable WHERE title = ?',
  timeout: 10000,
  values: ['lambda'])
});
```
The manager `query()` method is a use the shortcut method pool.query, in place of pool.getConnection() → connection.query() → connection.release().

```typscript
// Simple query with a specific connection
const conn = await pool.getConnection();
let results = await conn.query('SELECT * FROM mytable');
conn.release();
```

Once you've run all your queries and your serverless function is ready to return data, call the `flush()` method to perform connection management. 
This will do things like check the current number connections of pool, release and disconnect connections,
and if you wish, clean up zombies or even disconnect if there are too many connections being used in a server. 
Be sure to `await` its results before continuing.

```typscript
// Perform connection management tasks
await pool.flush()
```

Note that `flush()` will **NOT** necessarily terminate all the connections. Only if it has to to manage the connections. 
If you'd like to explicitly terminate the pool and connections, use the `end()` method.

```typscript
// Terminate the pool and connections
await pool.end();
```


## Configuration Options

Below is a table containing all of the possible configuration options for ServerlessManagerMysql. 

#### Pool Options and Connection Options
More details in MySQL Module [connection options](https://github.com/mysqljs/mysql#connection-options) and [Pool Options](https://github.com/mysqljs/mysql#pool-options).

| Property | Type | Description | Default |
| -------- | ---- | ----------- | ------- |
| host | `String` | The hostname of the database you are connecting to | `localhost` |
| port | `Integer` | The port number to connect to | `3306` |
| user | `String` | The MySQL user to authenticate as. That user will also be used to check the global connections in use by the user and kill them.  |  |
| password | `String` | The password of that MySQL user.  |  |
| connectTimeout | `Integer` | The milliseconds before a timeout occurs during the initial connection to the MySQL server  | 10000 |
| acquireTimeout | `Integer` | The milliseconds before a timeout occurs during the connection acquisition. This is slightly different from connectTimeout, because acquiring a pool connection does not always involve making a connection. If a connection request is queued, the time the request spends in the queue does not count towards this timeout.   | 10000 |
| waitForConnections | `Boolean` | Determines the pool's action when no connections are available and the limit has been reached. If true, the pool will queue the connection request and call it when one becomes available. If false, the pool will immediately call back with an error.  | false |
| connectionLimit | `Integer` |  The maximum number of connections to create at once **in one pool instance**. **Use the smallest possible value appropriate to your use case.**  | 10 |
| queueLimit | `Integer` |  The maximum number of connection requests the pool will queue before returning an error from getConnection. If set to 0, there is no limit to the number of queued connection requests.  | 0 |


#### Manager options

| Property | Type | Description | Default |
| -------- | ---- | ----------- | ------- |
| maxKeepAliveConnPerPool | `Integer` | The maximum number of connections you want to keep active on the pool instance. The flush () method will disconnect all connections released in the pool, leaving only this number of connections active. | 1 |
| maxRetries | `Integer` | Maximum number of times to retry a connection before throwing an error.  | `50` |
| retryDelay | `Integer` | The amount of milliseconds to wait before trying to connect again.  | `100` |
| killZombies | `Boolean` | Flag indicating whether or not you want module to manage global MySQL user connections for you. (Based on method of Jeremy Daly). *If this option is false, the module will only manage the connections released from the pool itself.*  | `true` |
| maxConnUtilization | `Number` | The percentage of total connections to use when connecting to your MySQL server. A value of `0.75` would use 75% of your total available connections. *Used only when `killZombies` is `true`.* | `0.75` |
| maxConnsFreq | `Integer` | The number of *milliseconds* to cache lookups of @@max_connections. *Used only when `killZombies` is `true`.* | `120000` |
| usedConnsFreq | `Integer` | The number of *milliseconds* to cache lookups of current connection usage. *Used only when `killZombies` is `true`.* | `0` |
| zombieMaxTimeout | `Integer` | The maximum number of *seconds* that a connection can stay idle before being recycled. *Used only when `killZombies` is `true`.* | `900` |
| zombieMinTimeout | `Integer` | The minimum number of *seconds* that a connection must be idle before the module will recycle it. *Used only when `killZombies` is `true`.* | `3` |
| mysqlLibrary | `Function` | Custom mysql library | `mysql` |

## AWS X-Ray support and custom libraries

```
Set your own mysql library, wrapped with AWS x-ray for instance
```typscript
import ServerlessManagerMysql from "serverless-manager-mysql";
import AWSXRay from "aws-xray-sdk";
import mysql from "mysql";

const pool = new ServerlessManagerMysql({
    host     : process.env.MYSQL_HOST,
    port     : process.env.MYSQL_PORT as any,
    database : process.env.MYSQL_DATABASE,
    user     : process.env.MYSQL_USER,
    password : process.env.MYSQL_PASSWORD,
}, {
    mysqlLibrary: AWSXRay.captureMySQL(mysql);
});
```

## Transaction Support
To work with transactions with Serverless Manager for MySQL  is very simple and safe.
Start a new transaction using the `beginTransaction()` and use the `ManagedTransaction` object to execute your queries.
- The `beginTransaction()` method will acquire an exclusive connection for the transaction from the pool. 
- The transaction `query()` method do all standard query options. 
- Call the `commit()` or `rollback()` will automatically close the transaction and release the connection back to the pool.

```typscript
// accquire exclusive connection and execute START TRANSACTION
const transaction = await pool.beginTransaction();

// perform queries
await transaction.query('INSERT INTO table (x) VALUES(?)', [1]);
await transaction.query('UPDATE table SET x = 1');

// execute COMMIT and release connection
transaction.commit();
```

## Reusing Persistent Connections
If you're using AWS Lambda with **callbacks**, be sure to set `context.callbackWaitsForEmptyEventLoop = false;` in your main handler. This will allow the freezing of connections and will prevent Lambda from hanging on open connections. 
See [here](https://www.jeremydaly.com/reuse-database-connections-aws-lambda/) for more information. 
If you are using `async` functions, this is no longer necessary.


## MySQL Server Configuration

You can use this module without changing any MySQL server configuration. Just be careful not to leave too many keep alive connections in the pool. 
**And always use the `flush ()` method before the callback of your handler function.**

The module will not manage all open connections on your server.
Management of open connections by the pool user and kill zoombies functionality will only be performed if the `killZombies` option is `true`.

The management of idle connections can also be done directly by the MySQL server, to do so, use the server `wait_timeout` and `interactive_timeout` parameters.

However, if you are going to use the module's `killZombies` option, be aware that:

If you set max `user_connections`, the module will only manage connections for that user. 
This is useful if you have multiple clients connecting to the same MySQL server (or cluster) 
and you want to make sure your serverless app doesn't use all of the available connections.

If you're not setting max `user_connections`, the user **MUST BE** granted the `PROCESS` privilege in order to count other connections. 
Otherwise it will assume that its connections are the only ones being used. 
Granting `PROCESS` is fairly safe as it is a *read only* permission and doesn't expose any sensitive data.

In any case, the module will only kill connections opened by the user configured in the pool options.


## Contributions
Contributions, ideas and bug reports are welcome and greatly appreciated. Please add [issues](https://github.com/douglasgsouza/serverless-mysql-manager/issues) for suggestions and bug reports or create a pull request.

## Acknowledgment

I would like to thank [Jeremy Daly](https://www.jeremydaly.com), for his contribution with fantastic articles on his blog, about connection reuse in Lambda and also for his [`serverless-mysql`](https://github.com/jeremydaly/serverless-mysql) module which I used some parts of.
