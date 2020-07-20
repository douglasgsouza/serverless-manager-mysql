/**
 * Serverless Manager for MySQL
 * Serverless Manager for MySQL is a wrapper for mysql module that manage your mysql connections
 * at serverless scale with transaction support and connection isolation.
 *
 * @author Douglas Gomes de Souza
 * @version 1.0.1
 * @licence MIT
 */

import * as MySQL from "mysql";
import {EscapeFunctions, FieldInfo, OkPacket, Pool, PoolConfig, PoolConnection, QueryOptions} from 'mysql';
// @ts-ignore
import {FieldPacket, RowDataPacket, ResultSetHeader} from "mysql/lib/protocol/packets";

interface IManagerOptions {
    debug?: boolean;
    maxKeepAliveConnPerPool?: number;
    maxRetries?: number;
    retryDelay?: number;
    killZombies?: boolean;
    maxConnUtilization?: number;
    zombieMaxTimeout?: number;
    zombieMinTimeout?: number;
    maxConnsFreq?: number;
    usedConnsFreq?: number;
    mysqlLibrary?: typeof MySQL;
}

export default class ServerlessManagerMysql {

    protected readonly lib: any;
    protected readonly pool: Pool;

    debug = false;

    protected readonly maxKeepAliveConnPerPool: number; //maximum number of connections to keep alive in the pool
    protected readonly maxRetries: number;
    protected readonly retryDelay: number;
    protected readonly killZombies: boolean;
    protected readonly maxConnUtilization: number;
    protected readonly zombieMaxTimeout: number;
    protected readonly zombieMinTimeout: number;
    protected readonly maxConnsFreq: number;
    protected readonly usedConnsFreq: number;

    protected managedFreeConnections: Map<number, PoolConnection> = new Map();

    protected poolOptions: PoolConfig;

    protected maxConns: {
        total: number;
        userLimit: boolean;
        updated: number;
    };

    protected usedConns: {
        total: number;
        maxAge: number;
        updated: number;
    };

    constructor(poolOptions: PoolConfig, managerOptions?: IManagerOptions) {

        //Set defaults of pool options
        poolOptions.connectionLimit    = Number.isInteger(poolOptions.connectionLimit) ? poolOptions.connectionLimit : 10;
        poolOptions.queueLimit         = Number.isInteger(poolOptions.queueLimit) ? poolOptions.queueLimit : 0;
        poolOptions.acquireTimeout     = Number.isInteger(poolOptions.acquireTimeout) ? poolOptions.acquireTimeout : 10000;
        poolOptions.waitForConnections = poolOptions.waitForConnections === true;

        if (poolOptions.waitForConnections && (!poolOptions.acquireTimeout || poolOptions.acquireTimeout <= 0)) {
            console.warn('Waiting for connections in the pool without acquireTimeout is not recommended.');
        }

        this.poolOptions = poolOptions;

        //Set defaults of manager options
        const opt = typeof managerOptions === 'object' && !Array.isArray(managerOptions) ? managerOptions : {}

        this.lib = opt.mysqlLibrary || MySQL;

        if (Number.isInteger(opt.maxKeepAliveConnPerPool)) {
            if (opt.maxKeepAliveConnPerPool < 0) {
                throw new Error('Invalid configuration: maxKeepAliveConnPerPool cannot be less than zero.');
            }
            if (opt.maxKeepAliveConnPerPool > poolOptions.connectionLimit) {
                throw new Error('Invalid configuration: maxKeepAliveConnPerPool cannot be greater than pool connection limit.');
            }
            this.maxKeepAliveConnPerPool = opt.maxKeepAliveConnPerPool;
        } else {
            this.maxKeepAliveConnPerPool = 1;
        }

        this.debug                = opt.debug === true || poolOptions.debug === true;
        this.maxRetries           = Number.isInteger(opt.maxRetries) ? opt.maxRetries! : 50;
        this.retryDelay           = Number.isInteger(opt.retryDelay) ? opt.retryDelay! : 100;
        this.killZombies          = opt.killZombies !== false;
        this.maxConnUtilization   = !isNaN(opt.maxConnUtilization) ? opt.maxConnUtilization : 0.75
        this.zombieMaxTimeout     = Number.isInteger(opt.zombieMaxTimeout) ? opt.zombieMaxTimeout : 900;
        this.zombieMinTimeout     = Number.isInteger(opt.zombieMinTimeout) ? opt.zombieMinTimeout : 3;
        this.maxConnsFreq         = Number.isInteger(opt.maxConnsFreq) ? opt.maxConnsFreq : 120000;
        this.usedConnsFreq        = Number.isInteger(opt.maxConnsFreq) ? opt.maxConnsFreq : 0;

        if (this.zombieMinTimeout < 0) {
            throw new Error('Invalid configuration: zombieMinTimeout cannot be less than zero.');
        }
        if (this.retryDelay < 0) {
            throw new Error('Invalid configuration: retryDelay cannot be less than zero.');
        }

        this.pool = this.lib.createPool(poolOptions);
        this.pool.on('acquire', this.onAcquireConnection.bind(this));
        this.pool.on('release', this.onReleaseConnection.bind(this));
    }

    /**
     * Delete managed free connection when pool acquire
     * @param connection
     */
    protected onAcquireConnection(connection: PoolConnection) {
        this.managedFreeConnections.delete(connection.threadId);

        this.log('acquire', {threadId: connection.threadId, totalFree: this.managedFreeConnections.size});
        this.log('current free: ', [...this.managedFreeConnections.keys()]);
    }

    /**
     * Add managed free connection when pool release
     * @param connection
     */
    protected onReleaseConnection(connection: PoolConnection) {
        this.managedFreeConnections.set(connection.threadId, connection);

        this.log('release', {threadId: connection.threadId, totalFree: this.managedFreeConnections.size});
        this.log('current free: ', [...this.managedFreeConnections.keys()]);
    }

    /**
     * Attempts to create a connection up to the limit of attempts. With each attempt, wait for the specified delay time.
     * @param retries Maximum number of attempts
     * @param delay  Delay time between attempts in milliseconds
     * @param attempt Current attempt number
     */
    protected getConnectionRetry(retries: number, delay: number, attempt: number = 1): Promise<ManagedConnection> {

        return new Promise<ManagedConnection>((resolve, reject) => {
            this.pool.getConnection((err, connection) => {
                if (err) return reject(err);
                resolve(new ManagedConnection(connection));
            });
        }).catch(err => {
            if (retries > 1) {
                this.log('Attempt ' + attempt + ': ' + err.message);
                this.log('Retrying...');
            } else if (attempt > 1) {
                this.log('Attempt ' + attempt + ': ' + err.message);
            }
            return new Promise(resolve => setTimeout(resolve, delay)).then(() => {
                return (retries > 1) ? this.getConnectionRetry(retries - 1, delay, ++attempt) : Promise.reject(err);
            });
        });
    }

    getConnection(): Promise<ManagedConnection> {
        const retries    = this.maxRetries;
        const retryDelay = this.retryDelay;
        return this.getConnectionRetry(retries, retryDelay);
    }

    /**
     * Disconnects free connections from the pool, keeping only the specified number of keep alive connections.
     * If configure to kill zombies it will also clear the zombie connections.
     */
    async flush() {

        this.log('flushing connections...');

        let zombiesConn: ManagedConnection;
        if (this.killZombies) {
            zombiesConn = await this.getConnection(); // reserve connection for zombie cleanup
        }

        this.log('flushing pool free connections...');

        for (let connection of this.managedFreeConnections.values()) {
            connection.destroy();
            this.managedFreeConnections.delete(connection.threadId);

            this.log('thread ' + connection.threadId + ' disconnected.');

            if (this.managedFreeConnections.size <= this.maxKeepAliveConnPerPool) {
                break;
            }
        }

        if (this.killZombies) {

            this.log('cleaning zombies connections...');

            await this.cleanZombies(zombiesConn);

            // if have enough free connections, it destroys the zombie cleanup connection
            if (this.maxKeepAliveConnPerPool == 0 || this.managedFreeConnections.size >= this.maxKeepAliveConnPerPool) {
                zombiesConn.destroy();
                this.managedFreeConnections.delete(zombiesConn.threadId);
            // otherwise, it just releases the zombie cleanup connection
            } else {
                zombiesConn.release();
            }

        }

        this.log('flush success.');
    }

    /**
     * Attempts to clean up zombies connections based on method of Jeremy Daly
     * @see <a href="https://github.com/jeremydaly/serverless-mysql">Serverless MySql</a>
     */
    protected async cleanZombies(conn: ManagedConnection) {

        const maxConns = await this.getMaxConnections(conn);
        const usedConns= await this.getTotalUsedConnections(conn);

        // If over utilization threshold, try and clean up zombies
        if (maxConns.total !== 0 && (usedConns.total / maxConns.total > this.maxConnUtilization)) {

            this.log('over utilization threshold. Trying to kill...');

            // Calculate the zombie timeout
            const timeout = Math.min(Math.max(usedConns.maxAge, this.zombieMinTimeout), this.zombieMaxTimeout);

            // Kill zombies if they are within the timeout
            if (timeout <= usedConns.maxAge) {
                const killedZombies = await this.killZombieConnections(conn, timeout);
                this.log('total killed: ', killedZombies);
            } else {
                this.log('nothing to kill');
            }

        // If zombies exist that are more than the max timeout, kill them
        } else if (usedConns.maxAge > this.zombieMaxTimeout) {
            this.log('has zombies above the maximum timeout. Trying to kill...');

            const killedZombies = await this.killZombieConnections(conn, this.zombieMaxTimeout)

            this.log('total killed: ', killedZombies);

        } else {
            this.log('nothing to kill');
        }
    }

    /**
     * Returns from the server the maximum number of connections allowed for the user.
     * @see <a href="https://github.com/jeremydaly/serverless-mysql">Serverless MySql</a>
     * @param conn
     */
    protected async getMaxConnections(conn: ManagedConnection) {
        //If cache expired
        if (!this.maxConns || (Date.now() - this.maxConns.updated > this.maxConnsFreq)) {

            const [res] = await conn.query<any>("SELECT IF(@@max_user_connections > 0, " +
                "LEAST(@@max_user_connections,@@max_connections), @@max_connections) AS total, " +
                "IF(@@max_user_connections > 0,true,false) AS userLimit");

            this.maxConns = {
                updated: Date.now(),
                total: res[0].total || 0,
                userLimit: res[0].userLimit === 1
            }

            this.log('retrieved maxConns:', this.maxConns);
        }

        return this.maxConns;
    }

    /**
     * Returns from the server the number of connections in use by the user.
     * @see <a href="https://github.com/jeremydaly/serverless-mysql">Serverless MySql</a>
     * @param conn
     */
    protected async getTotalUsedConnections(conn: ManagedConnection) {
        //If cache expired
        if (!this.usedConns || (Date.now() - this.usedConns.updated > this.usedConnsFreq)) {

            const [res] = await conn.query<any>("SELECT COUNT(`ID`) as total, MAX(`time`) as max_age " +
                "FROM `information_schema`.`processlist` WHERE `user` = ?", [this.poolOptions.user]);

            this.usedConns = {
                updated: Date.now(),
                total: res[0].total || 0,
                maxAge: res[0].max_age || 0
            }

            this.log('retrieved usedConns:', this.usedConns);
        }

        return this.usedConns;
    }

    /**
     * Try to kill the user threads that are sleeping for a minimum specified time.
     * @see <a href="https://github.com/jeremydaly/serverless-mysql">Serverless MySql</a>
     */
    protected async killZombieConnections(conn: ManagedConnection, mintime: number): Promise<number> {

        const [zombies] = await conn.query<any>("SELECT `ID`,`time` FROM `information_schema`.`processlist` " +
            "WHERE `command` = 'Sleep' AND `time` >= ? AND user = ? " +
            "ORDER BY time DESC", [mintime, this.poolOptions.user]);

        let totalKilled = 0;
        for (let i = 0; i < zombies.length; i++) {
            const zombieThreadId = zombies[i][0].ID;
            if (zombieThreadId !== conn.threadId) { //dont kill self connection
                try {
                    await conn.query("KILL ?", [zombieThreadId])
                    totalKilled++;
                    this.log('thread ' + zombieThreadId + ' killed.');
                } catch (e) {
                }
            }
        }
        return totalKilled;
    }

    /**
     * Run asynchronous query
     * @param sql
     * @param values
     */
    query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values?: any | any[]): Promise<[T, FieldInfo[]]>;
    query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(options: QueryOptions, values?: any | any[]): Promise<[T, FieldInfo[]]>;
    query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sqlOrOptions: any, values?: any | any[]): Promise<[T, FieldInfo[]]> {
        return new Promise((resolve, reject) => {
            this.pool.query(sqlOrOptions, values, (error, results, fields) => {
                if (error) return reject(error);
                resolve([results, fields]);
            });
        });
    }

    /**
     * Ends the pool by terminating all connections in the pool.
     * If configured to kill zombies it will also try to keep all connections that are sleeping on the server.
     */
    async end(): Promise<void> {
        this.log('ending pool killing connections ...');

        if (this.killZombies) {
            const conn = await this.getConnection();
            const killedZombies = await this.killZombieConnections(conn, this.zombieMinTimeout);
            this.log('total threads killed: ', killedZombies);
        }

        return new Promise((resolve, reject) => {
            this.pool.end(err => {
                if (err) return reject(err);
                this.log('pool successfully ended.');
                return resolve();
            });
        });
    }

    /**
     * Initiates a new transaction through an exclusive managed connection.
     * Returns a transaction object that should be used to execute queries within the transaction.
     */
    async beginTransaction(): Promise<ManagedTransaction> {
        const transactionConnection = await this.getConnection();
        await transactionConnection.beginTransaction();
        return new ManagedTransaction(transactionConnection);
    }

    /**
     * Writes to the log if configured to debug
     * @param args
     */
    protected log(...args: any) {
        if (this.debug) {
            console.log.apply(console, args);
        }
    }
}

/**
 * Managed connection wrapper for easy use asynchronously with promises.
 */
class ManagedConnection implements EscapeFunctions {

    protected readonly connection: PoolConnection;
    public readonly threadId: number;

    constructor(connection: PoolConnection) {
        this.connection = connection;
        this.threadId   = connection.threadId;
    }

    /**
     * Release the connection and return it to the pool so it can be used again.
     */
    release() {
        this.connection.release();
    }

    /**
     * Close the connection immediately, without waiting for any queued data (eg
     * queries) to be sent. No further events or callbacks will be triggered.
     */
    destroy() {
        this.connection.destroy();
    }


    /**
     * Run asynchronous query
     */
    query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string, values?: any | any[]): Promise<[T, FieldPacket[]]>;
    query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(options: QueryOptions, values?: any | any[]): Promise<[T, FieldPacket[]]>;
    query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sqlOrOptions: any, values?: any | any[]): Promise<[T, FieldPacket[]]> {
        return new Promise((resolve, reject) => {
            this.connection.query(sqlOrOptions, values, (error, results, fields) => {
                if (error) return reject(error);
                resolve([results, fields]);
            });
        });
    }

    /**
     * Convenience that execute the START TRANSACTION
     */
    beginTransaction(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.connection.beginTransaction(err => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    /**
     * Convenience that execute the COMMIT
     */
    commit(): Promise<void>   {
        return new Promise((resolve, reject) => {
            this.connection.commit(err => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    /**
     * Convenience that execute the ROLLBACK
     */
    rollback(): Promise<void>  {
        return new Promise((resolve, reject) => {
            this.connection.rollback(err => {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    escape(value: any, stringifyObjects?: boolean, timeZone?: string): string {
        return this.connection.escape(value, stringifyObjects, timeZone);
    }

    escapeId(value: string, forbidQualified?: boolean): string {
        return this.connection.escapeId(value, forbidQualified);
    }

    format(sql: string, values: any[], stringifyObjects?: boolean, timeZone?: string): string {
        return this.connection.format(sql, values, stringifyObjects, timeZone);
    }

}

/**
 * Managed transaction wrapper to facilitate use asynchronously with promises over a transaction-exclusive connection.
 */
class ManagedTransaction {
    private readonly connection: ManagedConnection;

    private closed: Boolean = false;

    constructor(connection: ManagedConnection) {
        this.connection = connection;
    }

    /**
     * Run asynchronous query in transaction connection
     */
    async query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sql: string , values?: any | any[] | { [param: string]: any }): Promise<[T, FieldPacket[]]>;
    async query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(options: QueryOptions, values?: any | any[] | { [param: string]: any }): Promise<[T, FieldPacket[]]>;
    async query<T extends RowDataPacket[][] | RowDataPacket[] | OkPacket | OkPacket[] | ResultSetHeader>(sqlOrOptions: any, values?: any | any[] | { [param: string]: any }): Promise<[T, FieldPacket[]]> {
        if (this.closed) {
            throw new Error('Transaction closed');
        }
        return this.connection.query(sqlOrOptions, values);
    }

    /**
     * Commit transaction and release connection.
     */
    async commit(): Promise<void> {
        if (this.closed) {
            throw new Error('Transaction closed');
        }
        return this.connection.commit().then(() => {
            this.closed = true;
            this.connection.release();
        });
    }

    /**
     * Rollback transaction and release connection.
     */
    async rollback(): Promise<void> {
        if (this.closed) {
            throw new Error('Transaction closed');
        }
        return this.connection.rollback().then(() => {
            this.closed = true;
            this.connection.release();
        });
    }
}
