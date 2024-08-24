async function kickOutHandler({ socket, options }) {
    if (typeof options.channel !== 'string')
        return;
    socket.channels.kickOut(options.channel, options.message);
}

async function publishHandler({ socket, options }) {
    socket.channels.write(options.channel, options.data);
}

async function removeAuthTokenHandler({ transport }) {
    await transport.changeToUnauthenticatedState();
}

async function setAuthTokenHandler({ transport, options }) {
    await transport.setAuthorization(options);
}

class BatchingPlugin {
    constructor(options) {
        this._isBatching = false;
        this.batchInterval = options?.batchInterval || 50;
        this.batchOnHandshakeDuration = options?.batchOnHandshakeDuration ?? false;
        this._batchingIntervalId = null;
        this._handshakeTimeoutId = null;
    }
    cancelBatching() {
        if (this._batchingIntervalId !== null) {
            clearInterval(this._batchingIntervalId);
        }
        this._isBatching = false;
        this._batchingIntervalId = null;
    }
    get isBatching() {
        return this._isBatching || this._batchingIntervalId !== null;
    }
    onReady() {
        if (this._isBatching) {
            this.start();
        }
        else if (typeof this.batchOnHandshakeDuration === 'number' && this.batchOnHandshakeDuration > 0) {
            this.start();
            this._handshakeTimeoutId = setTimeout(() => {
                this.stop();
            }, this.batchOnHandshakeDuration);
        }
    }
    onDisconnected() {
        this.cancelBatching();
    }
    startBatching() {
        this._isBatching = true;
        this.start();
    }
    start() {
        if (this._batchingIntervalId !== null) {
            return;
        }
        this._batchingIntervalId = setInterval(() => {
            this.flush();
        }, this.batchInterval);
    }
    stopBatching() {
        this._isBatching = false;
        this.stop();
    }
    stop() {
        if (this._batchingIntervalId !== null) {
            clearInterval(this._batchingIntervalId);
        }
        this._batchingIntervalId = null;
        if (this._handshakeTimeoutId !== null) {
            clearTimeout(this._handshakeTimeoutId);
            this._handshakeTimeoutId = null;
        }
        this.flush();
    }
}
class RequestBatchingPlugin extends BatchingPlugin {
    constructor(options) {
        super(options);
        this.type = 'requestBatching';
        this._requests = [];
        this._continue = null;
    }
    cancelBatching() {
        super.cancelBatching();
        this._requests = [];
        this._continue = null;
    }
    flush() {
        if (this._requests.length) {
            this._continue(this._requests);
            this._requests = [];
            this._continue = null;
        }
    }
    sendRequest({ requests, cont }) {
        if (!this.isBatching) {
            cont(requests);
            return;
        }
        this._continue = cont;
        this._requests.push(...requests);
    }
}
class ResponseBatchingPlugin extends BatchingPlugin {
    constructor(options) {
        super(options);
        this.type = 'responseBatching';
        this._responses = [];
        this._continue = null;
    }
    flush() {
        if (this._responses.length) {
            this._continue(this._responses);
            this._responses = [];
            this._continue = null;
        }
    }
    sendResponse({ responses, cont }) {
        if (!this.isBatching) {
            cont(responses);
            return;
        }
        this._continue = cont;
        this._responses.push(...responses);
    }
}

class Consumer {
    constructor(stream, id, startNode, timeout) {
        this.id = id;
        this._backpressure = 0;
        this.currentNode = startNode;
        this.timeout = timeout;
        this.isAlive = true;
        this.stream = stream;
        this.stream.setConsumer(this.id, this);
    }
    clearActiveTimeout(packet) {
        if (this._timeoutId !== undefined) {
            clearTimeout(this._timeoutId);
            delete this._timeoutId;
        }
    }
    getStats() {
        const stats = {
            id: this.id,
            backpressure: this._backpressure
        };
        if (this.timeout != null) {
            stats.timeout = this.timeout;
        }
        return stats;
    }
    _resetBackpressure() {
        this._backpressure = 0;
    }
    applyBackpressure(packet) {
        this._backpressure++;
    }
    releaseBackpressure(packet) {
        this._backpressure--;
    }
    getBackpressure() {
        return this._backpressure;
    }
    write(packet) {
        this.clearActiveTimeout(packet);
        this.applyBackpressure(packet);
        if (this._resolve) {
            this._resolve();
            delete this._resolve;
        }
    }
    kill(value) {
        this._killPacket = { value, done: true };
        if (this._timeoutId !== undefined) {
            this.clearActiveTimeout(this._killPacket);
        }
        this._killPacket = { value, done: true };
        this._destroy();
        if (this._resolve) {
            this._resolve();
            delete this._resolve;
        }
    }
    _destroy() {
        this.isAlive = false;
        this._resetBackpressure();
        this.stream.removeConsumer(this.id);
    }
    async _waitForNextItem(timeout) {
        return new Promise((resolve, reject) => {
            this._resolve = resolve;
            let timeoutId;
            if (timeout !== undefined) {
                // Create the error object in the outer scope in order
                // to get the full stack trace.
                let error = new Error('Stream consumer iteration timed out');
                (async () => {
                    let delay = wait$1(timeout);
                    timeoutId = delay.timeoutId;
                    await delay.promise;
                    error.name = 'TimeoutError';
                    delete this._resolve;
                    reject(error);
                })();
            }
            this._timeoutId = timeoutId;
        });
    }
    [Symbol.asyncIterator]() {
        return this;
    }
}
function wait$1(timeout) {
    let timeoutId = undefined;
    let promise = new Promise((resolve) => {
        timeoutId = setTimeout(resolve, timeout);
    });
    return { timeoutId: timeoutId, promise };
}

class WritableStreamConsumer extends Consumer {
    constructor(stream, id, startNode, timeout) {
        super(stream, id, startNode, timeout);
    }
    async next() {
        this.stream.setConsumer(this.id, this);
        while (true) {
            if (!this.currentNode.next) {
                try {
                    await this._waitForNextItem(this.timeout);
                }
                catch (error) {
                    this._destroy();
                    throw error;
                }
            }
            if (this._killPacket) {
                this._destroy();
                let killPacket = this._killPacket;
                delete this._killPacket;
                return killPacket;
            }
            this.currentNode = this.currentNode.next;
            this.releaseBackpressure(this.currentNode.data);
            if (this.currentNode.consumerId && this.currentNode.consumerId !== this.id) {
                continue;
            }
            if (this.currentNode.data.done) {
                this._destroy();
            }
            return this.currentNode.data;
        }
    }
    return() {
        this.currentNode = null;
        this._destroy();
        return {};
    }
}

class ConsumableStream {
    async next(timeout) {
        let asyncIterator = this.createConsumer(timeout);
        let result = await asyncIterator.next();
        asyncIterator.return();
        return result;
    }
    async once(timeout) {
        let result = await this.next(timeout);
        if (result.done) {
            // If stream was ended, this function should never resolve unless
            // there is a timeout; in that case, it should reject early.
            if (timeout == null) {
                await new Promise(() => { });
            }
            else {
                const error = new Error('Stream consumer operation timed out early because stream ended');
                error.name = 'TimeoutError';
                throw error;
            }
        }
        return result.value;
    }
    [Symbol.asyncIterator]() {
        return this.createConsumer();
    }
}

class WritableConsumableStream extends ConsumableStream {
    constructor(options) {
        super();
        options = options || {};
        this.nextConsumerId = 1;
        this.generateConsumerId = options.generateConsumerId;
        if (!this.generateConsumerId) {
            this.generateConsumerId = () => this.nextConsumerId++;
        }
        this.removeConsumerCallback = options.removeConsumerCallback;
        this._consumers = new Map();
        // Tail node of a singly linked list.
        this.tailNode = {
            next: null,
            data: {
                value: undefined,
                done: false
            }
        };
    }
    _write(data, consumerId) {
        let dataNode = {
            data,
            next: null
        };
        if (consumerId) {
            dataNode.consumerId = consumerId;
        }
        this.tailNode.next = dataNode;
        this.tailNode = dataNode;
        for (let consumer of this._consumers.values()) {
            consumer.write(dataNode.data);
        }
    }
    write(value) {
        this._write({ value, done: false });
    }
    close(value) {
        this._write({ value, done: true });
    }
    writeToConsumer(consumerId, value) {
        this._write({ value, done: false }, consumerId);
    }
    closeConsumer(consumerId, value) {
        this._write({ value, done: true }, consumerId);
    }
    kill(value) {
        for (let consumerId of this._consumers.keys()) {
            this.killConsumer(consumerId, value);
        }
    }
    killConsumer(consumerId, value) {
        let consumer = this._consumers.get(consumerId);
        if (!consumer) {
            return;
        }
        consumer.kill(value);
    }
    getBackpressure(consumerId) {
        if (consumerId === undefined) {
            let maxBackpressure = 0;
            for (let consumer of this._consumers.values()) {
                let backpressure = consumer.getBackpressure();
                if (backpressure > maxBackpressure) {
                    maxBackpressure = backpressure;
                }
            }
            return maxBackpressure;
        }
        let consumer = this._consumers.get(consumerId);
        if (consumer) {
            return consumer.getBackpressure();
        }
        return 0;
    }
    hasConsumer(consumerId) {
        return this._consumers.has(consumerId);
    }
    setConsumer(consumerId, consumer) {
        this._consumers.set(consumerId, consumer);
        if (!consumer.currentNode) {
            consumer.currentNode = this.tailNode;
        }
    }
    removeConsumer(consumerId) {
        let result = this._consumers.delete(consumerId);
        if (this.removeConsumerCallback) {
            this.removeConsumerCallback(consumerId);
        }
        return result;
    }
    getConsumerStats(consumerId) {
        if (consumerId === undefined) {
            let consumerStats = [];
            for (let consumer of this._consumers.values()) {
                consumerStats.push(consumer.getStats());
            }
            return consumerStats;
        }
        const consumer = this._consumers.get(consumerId);
        if (consumer) {
            return consumer.getStats();
        }
        return undefined;
    }
    createConsumer(timeout) {
        return new WritableStreamConsumer(this, this.generateConsumerId(), this.tailNode, timeout);
    }
    getConsumerList() {
        return [...this._consumers.values()];
    }
    getConsumerCount() {
        return this._consumers.size;
    }
}

class InOrderPlugin {
    //private readonly _outboundMessageStream: WritableConsumableStream<SendRequestPluginArgs<T>>;
    constructor() {
        this._inboundMessageStream = new WritableConsumableStream();
        //this._outboundMessageStream = new WritableConsumableStream<SendRequestPluginArgs<T>>;
        this.handleInboundMessageStream();
        //this.handleOutboundMessageStream();
    }
    handleInboundMessageStream() {
        (async () => {
            for await (let { message, callback, promise } of this._inboundMessageStream) {
                callback(null, message);
                try {
                    await promise;
                }
                catch (err) {
                    // Dont throw it is handled in the socket transport
                }
            }
        })();
    }
    /*
        handleOutboundMessageStream(): void {
            (async () => {
                for await (let { requests, cont } of this._outboundMessageStream) {
                    await new Promise<void>((resolve) => {
                        const reqCol = new RequestCollection(requests);
    
                        if (reqCol.isDone()) {
                            resolve();
                            cont(requests);
                            return;
                        }
    
                        reqCol.listen(() => {
                            resolve();
                        });
    
                        cont(requests);
                    });
                }
            })();
        }
    */
    onEnd({ transport }) {
        if (transport.streamCleanupMode === 'close') {
            this._inboundMessageStream.close();
            //this._outboundMessageStream.close();
        }
        else if (transport.streamCleanupMode === 'kill') {
            this._inboundMessageStream.kill();
            //this._outboundMessageStream.kill();
        }
    }
    onMessageRaw(options) {
        let callback;
        const promise = new Promise((resolve, reject) => {
            callback = (err, data) => {
                if (err) {
                    reject(err);
                    return;
                }
                resolve(data);
            };
        });
        this._inboundMessageStream.write({ callback, ...options });
        return promise;
    }
}

const SYSTEM_METHODS = ['#handshake', '#removeAuthToken'];
class OfflinePlugin {
    constructor() {
        this.type = 'offline';
        this._isReady = false;
        this._requests = [];
        this._continue = null;
    }
    sendRequest({ requests, cont }) {
        if (this._isReady) {
            cont(requests);
            return;
        }
        const systemRequests = requests.filter(item => SYSTEM_METHODS.indexOf(String(item.method)) > -1);
        let otherRequests = requests;
        if (systemRequests.length) {
            otherRequests = (systemRequests.length === requests.length) ? [] : requests.filter(item => SYSTEM_METHODS.indexOf(String(item.method)) < 0);
        }
        if (otherRequests.length) {
            this._continue = cont;
            this._requests.push(otherRequests);
        }
        if (systemRequests.length) {
            cont(systemRequests);
        }
    }
    onReady() {
        this._isReady = true;
        this.flush();
    }
    onClose() {
        this._isReady = false;
    }
    onDisconnected() {
        this._requests = [];
        this._continue = null;
    }
    flush() {
        if (this._requests.length) {
            for (const reqs of this._requests) {
                this._continue(reqs);
            }
            this._requests = [];
            this._continue = null;
        }
    }
}

function isAuthEngine(auth) {
    return (typeof auth === 'object' && 'saveToken' in auth && 'removeToken' in auth && 'loadToken' in auth);
}
class LocalStorageAuthEngine {
    constructor({ authTokenName } = {}) {
        this._internalStorage = {};
        this.isLocalStorageEnabled = this._checkLocalStorageEnabled();
        this._authTokenName = authTokenName ?? 'socketmesh.authToken';
    }
    _checkLocalStorageEnabled() {
        let err;
        try {
            // Safari, in Private Browsing Mode, looks like it supports localStorage but all calls to setItem
            // throw QuotaExceededError. We're going to detect this and avoid hard to debug edge cases.
            localStorage.setItem('__localStorageTest', "1");
            localStorage.removeItem('__localStorageTest');
        }
        catch (e) {
            err = e;
        }
        return !err;
    }
    async saveToken(token) {
        if (this.isLocalStorageEnabled) {
            localStorage.setItem(this._authTokenName, token);
        }
        else {
            this._internalStorage[this._authTokenName] = token;
        }
        return token;
    }
    async removeToken() {
        let loadPromise = this.loadToken();
        if (this.isLocalStorageEnabled) {
            localStorage.removeItem(this._authTokenName);
        }
        else {
            delete this._internalStorage[this._authTokenName];
        }
        return loadPromise;
    }
    async loadToken() {
        let token;
        if (this.isLocalStorageEnabled) {
            token = localStorage.getItem(this._authTokenName);
        }
        else {
            token = this._internalStorage[this._authTokenName] || null;
        }
        return token;
    }
}

class ChannelListeners {
    constructor(name, listeners) {
        this._name = name;
        this._listeners = listeners;
    }
    getConsumerStats(consumerId) {
        if (typeof consumerId === 'number') {
            if (this.hasConsumer(consumerId)) {
                return this._listeners.getConsumerStats(consumerId);
            }
            return undefined;
        }
        return this._listeners.getConsumerStats(this._name, consumerId /* eventName */);
    }
    getBackpressure(consumerId) {
        if (typeof consumerId === 'number') {
            if (this.hasConsumer(consumerId)) {
                return this._listeners.getBackpressure(consumerId);
            }
            return 0;
        }
        return this._listeners.getBackpressure(this._name, consumerId /* eventName */);
    }
    hasConsumer(eventName, consumerId) {
        if (typeof eventName === 'string') {
            return this._listeners.hasConsumer(this._name, eventName, consumerId);
        }
        return this._listeners.hasConsumer(this._name, eventName /* consumerId */);
    }
    close(eventName) {
        this._listeners.close(this._name, eventName);
    }
    kill(eventName) {
        if (typeof eventName === 'number') {
            if (this.hasConsumer(eventName /* consumerId */)) {
                this._listeners.kill(eventName /* consumerId */);
            }
            return;
        }
        this._listeners.kill(this._name, eventName);
    }
}

class ChannelOutput {
    constructor(name, output) {
        this._name = name;
        this._output = output;
    }
    hasConsumer(consumerId) {
        return this._output.hasConsumer(this._name, consumerId);
    }
    getBackpressure(consumerId) {
        if (typeof consumerId === 'number') {
            if (this.hasConsumer(consumerId)) {
                return this._output.getBackpressure(consumerId);
            }
            return 0;
        }
        return this._output.getBackpressure(this._name);
    }
    getConsumerStats(consumerId) {
        if (typeof consumerId === 'number') {
            if (this.hasConsumer(consumerId)) {
                return this._output.getConsumerStats(consumerId);
            }
            return undefined;
        }
        return this._output.getConsumerStats(this._name);
    }
    close() {
        this._output.close(this._name);
    }
    kill(consumerId) {
        if (typeof consumerId === 'number') {
            if (this.hasConsumer(consumerId)) {
                this._output.kill(consumerId);
            }
            return;
        }
        this._output.kill(this._name);
    }
}

class Channel extends ConsumableStream {
    constructor(name, channels, eventDemux, dataDemux) {
        super();
        this.name = name;
        this.channels = channels;
        this.listeners = new ChannelListeners(name, channels.listeners);
        this.output = new ChannelOutput(name, channels.output);
        this._eventDemux = eventDemux;
        this._dataStream = dataDemux.listen(this.name);
    }
    emit(event, data) {
        this._eventDemux.write(`${this.name}/${event}`, data);
    }
    listen(event) {
        return this._eventDemux.listen(`${this.name}/${event}`);
    }
    createConsumer(timeout) {
        return this._dataStream.createConsumer(timeout);
    }
    close() {
        this.channels.close(this.name);
    }
    closeEvent(event) {
        this._eventDemux.close(`${this.name}/${event}`);
    }
    getBackpressure() {
        return this.channels.getBackpressure(this.name);
    }
    kill() {
        this.channels.kill(this.name);
    }
    killEvent(event) {
        this._eventDemux.kill(`${this.name}/${event}`);
    }
    get state() {
        return this.channels.getState(this.name);
    }
    get options() {
        return this.channels.getOptions(this.name);
    }
    subscribe(options) {
        this.channels.subscribe(this.name, options);
    }
    unsubscribe() {
        this.channels.unsubscribe(this.name);
    }
    isSubscribed(includePending) {
        return this.channels.isSubscribed(this.name, includePending);
    }
    transmitPublish(data) {
        return this.channels.transmitPublish(this.name, data);
    }
    invokePublish(data) {
        return this.channels.invokePublish(this.name, data);
    }
}

class DemuxedConsumableStream extends ConsumableStream {
    constructor(streamDemux, name) {
        super();
        this._streamDemux = streamDemux;
        this.name = name;
    }
    createConsumer(timeout) {
        return this._streamDemux.createConsumer(this.name, timeout);
    }
}

class StreamDemux {
    constructor() {
        this.streams = {};
        this._nextConsumerId = 1;
        this.generateConsumerId = () => {
            return this._nextConsumerId++;
        };
    }
    write(streamName, value) {
        if (this.streams[streamName]) {
            this.streams[streamName].write(value);
        }
        if (this._allEventsStream) {
            this._allEventsStream.write({ stream: streamName, value });
        }
    }
    close(streamName = '', value) {
        if (typeof streamName === 'number') {
            for (let stream of Object.values(this.streams)) {
                if (stream.hasConsumer(streamName)) {
                    return stream.closeConsumer(streamName, value);
                }
            }
            return;
        }
        if (streamName) {
            if (this._allEventsStream) {
                this._allEventsStream.write({ stream: streamName, value });
            }
            if (this.streams[streamName]) {
                this.streams[streamName].close(value);
            }
        }
        else {
            this._allEventsStream.close();
        }
    }
    closeAll(value) {
        for (let [streamName, stream] of Object.entries(this.streams)) {
            if (this._allEventsStream) {
                this._allEventsStream.write({ stream: streamName, value });
            }
            stream.close(value);
        }
        if (this._allEventsStream) {
            this._allEventsStream.close();
        }
    }
    writeToConsumer(consumerId, value) {
        for (let stream of Object.values(this.streams)) {
            if (stream.hasConsumer(consumerId)) {
                return stream.writeToConsumer(consumerId, value);
            }
        }
    }
    getConsumerStats(consumerId) {
        if (consumerId === undefined) {
            const allStatsList = [];
            if (this._allEventsStream) {
                allStatsList.push(...this.getConsumerStats(''));
            }
            for (let streamName of Object.keys(this.streams)) {
                allStatsList.push(...this.getConsumerStats(streamName));
            }
            return allStatsList;
        }
        if (consumerId === '') {
            return (!this._allEventsStream ? [] :
                this._allEventsStream
                    .getConsumerStats()
                    .map((stats) => {
                    return {
                        ...stats,
                        stream: consumerId
                    };
                }));
        }
        if (typeof consumerId === 'string') {
            return (!this.streams[consumerId] ? [] :
                this.streams[consumerId]
                    .getConsumerStats()
                    .map((stats) => {
                    return {
                        ...stats,
                        stream: consumerId
                    };
                }));
        }
        if (this._allEventsStream && this._allEventsStream.hasConsumer(consumerId)) {
            return {
                stream: '',
                ...this._allEventsStream.getConsumerStats(consumerId)
            };
        }
        for (let [streamName, stream] of Object.entries(this.streams)) {
            if (stream.hasConsumer(consumerId)) {
                return {
                    stream: streamName,
                    ...stream.getConsumerStats(consumerId)
                };
            }
        }
        return undefined;
    }
    kill(streamName = '', value) {
        if (typeof streamName === 'number') {
            for (let stream of Object.values(this.streams)) {
                if (stream.hasConsumer(streamName)) {
                    return stream.killConsumer(streamName, value);
                }
            }
            return;
        }
        if (streamName && this.streams[streamName]) {
            if (this._allEventsStream) {
                this._allEventsStream.write({ stream: streamName, value });
            }
            this.streams[streamName].kill(value);
        }
        if (!streamName && this._allEventsStream) {
            this._allEventsStream.kill();
        }
    }
    killAll(value) {
        for (let [streamName, stream] of Object.entries(this.streams)) {
            if (this._allEventsStream) {
                this._allEventsStream.write({ stream: streamName, value });
            }
            stream.kill(value);
        }
        if (this._allEventsStream) {
            this._allEventsStream.kill();
        }
    }
    getBackpressure(streamName) {
        if (typeof streamName === 'string') {
            if (!streamName) {
                return this._allEventsStream?.getBackpressure() ?? 0;
            }
            if (this.streams[streamName]) {
                return this.streams[streamName].getBackpressure();
            }
            return 0;
        }
        if (typeof streamName === 'number') {
            if (this._allEventsStream && this._allEventsStream.hasConsumer(streamName)) {
                return this._allEventsStream.getBackpressure(streamName);
            }
            for (let stream of Object.values(this.streams)) {
                if (stream.hasConsumer(streamName)) {
                    return stream.getBackpressure(streamName);
                }
            }
            return 0;
        }
        return Object.values(this.streams).reduce((max, stream) => Math.max(max, stream.getBackpressure()), this._allEventsStream?.getBackpressure() ?? 0);
    }
    hasConsumer(streamName, consumerId) {
        if (typeof streamName === 'number') {
            return this._allEventsStream?.hasConsumer(streamName) || Object.values(this.streams).some(stream => stream.hasConsumer(streamName));
        }
        if (streamName && this.streams[streamName]) {
            return this.streams[streamName].hasConsumer(consumerId);
        }
        if (!streamName && this._allEventsStream) {
            return this._allEventsStream.hasConsumer(consumerId);
        }
        return false;
    }
    getConsumerCount(streamName) {
        if (!streamName && this._allEventsStream) {
            return this._allEventsStream.getConsumerCount();
        }
        if (streamName && this.streams[streamName]) {
            return this.streams[streamName].getConsumerCount();
        }
        return 0;
    }
    createConsumer(streamName, timeout) {
        if (!streamName) {
            streamName = '';
        }
        else if (typeof streamName === 'number') {
            timeout = streamName;
            streamName = '';
        }
        if (!streamName) {
            if (!this._allEventsStream) {
                this._allEventsStream = new WritableConsumableStream({
                    generateConsumerId: this.generateConsumerId,
                    removeConsumerCallback: () => {
                        if (!this.getConsumerCount('')) {
                            this._allEventsStream = null;
                        }
                    }
                });
            }
            return this._allEventsStream.createConsumer(timeout);
        }
        if (!this.streams[streamName]) {
            this.streams[streamName] = new WritableConsumableStream({
                generateConsumerId: this.generateConsumerId,
                removeConsumerCallback: () => {
                    if (!this.getConsumerCount(streamName)) {
                        delete this.streams[streamName];
                    }
                }
            });
        }
        return this.streams[streamName].createConsumer(timeout);
    }
    listen(streamName = '') {
        return new DemuxedConsumableStream(this, streamName);
    }
    unlisten(streamName = '') {
        if (!streamName) {
            this._allEventsStream = null;
        }
        else {
            delete this.streams[streamName];
        }
    }
}

class StreamDemuxWrapper {
    constructor(stream) {
        this._streamDemux = stream;
    }
    listen(name) {
        return this._streamDemux.listen(name);
    }
    close(name) {
        if (name === undefined) {
            this._streamDemux.closeAll();
        }
        this._streamDemux.close(name);
    }
    kill(name) {
        if (name === undefined) {
            this._streamDemux.killAll();
            return;
        }
        this._streamDemux.kill(name);
    }
    getConsumerStats(consumerId) {
        return this._streamDemux.getConsumerStats(consumerId);
    }
    getBackpressure(consumerId) {
        return this._streamDemux.getBackpressure(consumerId);
    }
    hasConsumer(name, consumerId) {
        if (typeof name === "string") {
            return this._streamDemux.hasConsumer(name, consumerId);
        }
        return this._streamDemux.hasConsumer(name /* consumerId */);
    }
}

class ChannelsListeners {
    constructor(eventDemux) {
        this._eventDemux = eventDemux;
    }
    getConsumerStats(channelName, eventName) {
        if (channelName === undefined) {
            return this._eventDemux.getConsumerStats();
        }
        if (typeof channelName === 'number') {
            return this._eventDemux.getConsumerStats(channelName /* consumerId */);
        }
        if (typeof eventName === 'string') {
            return this._eventDemux.getConsumerStats(`${channelName}/${eventName}`);
        }
        return this.getAllStreamNames(channelName)
            .map((streamName) => {
            return this._eventDemux.getConsumerStats(streamName);
        })
            .reduce((accumulator, statsList) => {
            statsList.forEach((stats) => {
                accumulator.push(stats);
            });
            return accumulator;
        }, []);
    }
    getBackpressure(channelName, eventName) {
        if (channelName === undefined) {
            return this._eventDemux.getBackpressure();
        }
        if (typeof channelName === 'number') {
            return this._eventDemux.getBackpressure(channelName /* consumerId */);
        }
        if (typeof eventName === 'string') {
            return this._eventDemux.getBackpressure(`${channelName}/${eventName}`);
        }
        let listenerStreamBackpressures = this.getAllStreamNames(channelName)
            .map((streamName) => {
            return this._eventDemux.getBackpressure(streamName);
        });
        return Math.max(...listenerStreamBackpressures.concat(0));
    }
    close(channelName, eventName) {
        if (channelName === undefined) {
            this._eventDemux.closeAll();
            return;
        }
        if (typeof eventName === 'string') {
            this._eventDemux.close(`${channelName}/${eventName}`);
            return;
        }
        this.getAllStreamNames(channelName)
            .forEach((streamName) => {
            this._eventDemux.close(streamName);
        });
    }
    kill(channelName, eventName) {
        if (channelName === undefined) {
            this._eventDemux.killAll();
            return;
        }
        if (typeof channelName === 'number') {
            this._eventDemux.kill(channelName /* consumerId */);
            return;
        }
        if (eventName) {
            this._eventDemux.kill(`${channelName}/${eventName}`);
            return;
        }
        this.getAllStreamNames(channelName)
            .forEach((streamName) => {
            this._eventDemux.kill(streamName);
        });
    }
    hasConsumer(channelName, eventName, consumerId) {
        if (typeof eventName === 'string') {
            return this._eventDemux.hasConsumer(`${channelName}/${eventName}`, consumerId);
        }
        return this.getAllStreamNames(channelName)
            .some((streamName) => {
            return this._eventDemux.hasConsumer(streamName, eventName /* consumerId */);
        });
    }
    getAllStreamNames(channelName) {
        const streamNamesLookup = this._eventDemux.getConsumerStats()
            .filter((stats) => {
            return stats.stream.indexOf(`${channelName}/`) === 0;
        })
            .reduce((accumulator, stats) => {
            accumulator[stats.stream] = true;
            return accumulator;
        }, {});
        return Object.keys(streamNamesLookup);
    }
}

class AsyncStreamEmitter {
    constructor() {
        this._listenerDemux = new StreamDemux();
    }
    static from(object) {
        const result = new AsyncStreamEmitter();
        const objEmitMethod = object.emit.bind(object);
        const resultEmitMethod = result.emit.bind(result);
        object.emit = (eventName, ...args) => {
            const result = objEmitMethod.call(null, eventName, ...args);
            resultEmitMethod.call(null, eventName, args);
            return result;
        };
        // Prevent EventEmitter from throwing on error.
        if (object.on) {
            object.on('error', () => { });
        }
        if (object.listenerCount) {
            const objListenerCountMethod = object.listenerCount.bind(object);
            object.listenerCount = (eventName, listener) => {
                const eventListenerCount = objListenerCountMethod(eventName, listener);
                const streamConsumerCount = result.getListenerConsumerCount(eventName);
                return eventListenerCount + streamConsumerCount;
            };
        }
        return result;
    }
    emit(eventName, data) {
        this._listenerDemux.write(eventName, data);
    }
    listen(eventName) {
        return this._listenerDemux.listen(eventName);
    }
    closeListeners(eventName) {
        if (eventName === undefined) {
            this._listenerDemux.closeAll();
            return;
        }
        this._listenerDemux.close(eventName);
    }
    getListenerConsumerStats(consumerId) {
        return this._listenerDemux.getConsumerStats(consumerId);
    }
    getListenerConsumerCount(eventName) {
        return this._listenerDemux.getConsumerCount(eventName);
    }
    killListeners(eventName) {
        if (eventName === undefined) {
            this._listenerDemux.killAll();
            return;
        }
        this._listenerDemux.kill(eventName);
    }
    getListenerBackpressure(eventName) {
        return this._listenerDemux.getBackpressure(eventName);
    }
    removeListener(eventName) {
        this._listenerDemux.unlisten(eventName);
    }
    ;
    hasListenerConsumer(eventName, consumerId) {
        return this._listenerDemux.hasConsumer(eventName, consumerId);
    }
}

class Channels extends AsyncStreamEmitter {
    constructor(options) {
        super();
        if (!options) {
            options = {};
        }
        this.channelPrefix = options.channelPrefix;
        this._channelMap = {};
        this._channelEventDemux = new StreamDemux();
        this.listeners = new ChannelsListeners(this._channelEventDemux);
        this._channelDataDemux = new StreamDemux();
        this.output = new StreamDemuxWrapper(this._channelDataDemux);
    }
    // Cancel any pending subscribe callback
    cancelPendingSubscribeCallback(channel) {
        if (channel.subscribeAbort) {
            channel.subscribeAbort();
        }
    }
    channel(channelName) {
        this._channelMap[channelName];
        return new Channel(channelName, this, this._channelEventDemux, this._channelDataDemux);
    }
    close(channelName) {
        this.output.close(channelName);
        this.listeners.close(channelName);
    }
    decorateChannelName(channelName) {
        return `${this.channelPrefix || ''}${channelName}`;
    }
    kill(channelName) {
        this.output.kill(channelName);
        this.listeners.kill(channelName);
    }
    getBackpressure(channelName) {
        return Math.max(this.output.getBackpressure(channelName), this.listeners.getBackpressure(channelName));
    }
    getState(channelName) {
        const channel = this._channelMap[channelName];
        if (channel) {
            return channel.state;
        }
        return 'unsubscribed';
    }
    getOptions(channelName) {
        const channel = this._channelMap[channelName];
        if (channel) {
            return { ...channel.options };
        }
        return {};
    }
    kickOut(channelName, message) {
        const undecoratedChannelName = this.undecorateChannelName(channelName);
        const channel = this._channelMap[undecoratedChannelName];
        if (channel) {
            this.emit('kickOut', {
                channel: undecoratedChannelName,
                message: message
            });
            this._channelEventDemux.write(`${undecoratedChannelName}/kickOut`, { channel: undecoratedChannelName, message });
            this.triggerChannelUnsubscribe(channel);
        }
    }
    subscribe(channelName, options) {
        options = options || {};
        let channel = this._channelMap[channelName];
        const sanitizedOptions = {
            waitForAuth: !!options.waitForAuth
        };
        if (options.priority != null) {
            sanitizedOptions.priority = options.priority;
        }
        if (options.data !== undefined) {
            sanitizedOptions.data = options.data;
        }
        if (!channel) {
            channel = {
                name: channelName,
                state: 'pending',
                options: sanitizedOptions
            };
            this._channelMap[channelName] = channel;
            this.trySubscribe(channel);
        }
        else if (options) {
            channel.options = sanitizedOptions;
        }
        const channelIterable = new Channel(channelName, this, this._channelEventDemux, this._channelDataDemux);
        return channelIterable;
    }
    triggerChannelSubscribe(channel, options) {
        const channelName = channel.name;
        if (channel.state !== 'subscribed') {
            const oldState = channel.state;
            channel.state = 'subscribed';
            const stateChangeData = {
                channel: channelName,
                oldState,
                newState: channel.state,
                options
            };
            this._channelEventDemux.write(`${channelName}/subscribeStateChange`, stateChangeData);
            this._channelEventDemux.write(`${channelName}/subscribe`, { channel: channel.name, options });
            this.emit('subscribeStateChange', stateChangeData);
            this.emit('subscribe', { channel: channelName, options });
        }
    }
    triggerChannelUnsubscribe(channel, setAsPending) {
        const channelName = channel.name;
        this.cancelPendingSubscribeCallback(channel);
        if (channel.state === 'subscribed') {
            const stateChangeData = {
                channel: channel.name,
                oldState: channel.state,
                newState: setAsPending ? 'pending' : 'unsubscribed',
                options: channel.options
            };
            this._channelEventDemux.write(`${channelName}/subscribeStateChange`, stateChangeData);
            this._channelEventDemux.write(`${channelName}/unsubscribe`, { channel: channel.name });
            this.emit('subscribeStateChange', stateChangeData);
            this.emit('unsubscribe', { channel: channelName });
        }
        if (setAsPending) {
            channel.state = 'pending';
        }
        else {
            delete this._channelMap[channelName];
        }
    }
    undecorateChannelName(channelName) {
        if (this.channelPrefix && channelName.indexOf(this.channelPrefix) === 0) {
            return channelName.replace(this.channelPrefix, '');
        }
        return channelName;
    }
    unsubscribe(channelName) {
        const channel = this._channelMap[channelName];
        if (channel) {
            this.tryUnsubscribe(channel);
        }
    }
    subscriptions(includePending) {
        const subs = [];
        Object.keys(this._channelMap).forEach((channelName) => {
            if (includePending || this._channelMap[channelName].state === 'subscribed') {
                subs.push(channelName);
            }
        });
        return subs;
    }
    isSubscribed(channelName, includePending) {
        const channel = this._channelMap[channelName];
        if (includePending) {
            return !!channel;
        }
        return !!channel && channel.state === 'subscribed';
    }
    emit(eventName, data) {
        super.emit(eventName, data);
    }
    listen(eventName) {
        return super.listen(eventName);
    }
    write(channelName, data) {
        const undecoratedChannelName = this.undecorateChannelName(channelName);
        const isSubscribed = this.isSubscribed(undecoratedChannelName, true);
        if (isSubscribed) {
            this._channelDataDemux.write(undecoratedChannelName, data);
        }
    }
}

class ClientChannels extends Channels {
    constructor(transport, options) {
        if (!options) {
            options = {};
        }
        super(options);
        this.autoSubscribeOnConnect = options.autoSubscribeOnConnect ?? true;
        this._transport = transport;
        this._preparingPendingSubscriptions = false;
        this._transport.plugins.push({
            type: 'channels',
            onAuthenticated: () => {
                if (!this._preparingPendingSubscriptions) {
                    this.processPendingSubscriptions();
                }
            },
            onReady: () => {
                if (this.autoSubscribeOnConnect) {
                    this.processPendingSubscriptions();
                }
            },
            onClose: () => {
                this.suspendSubscriptions();
            },
        });
    }
    suspendSubscriptions() {
        for (const channel in this._channelMap) {
            this.triggerChannelUnsubscribe(this._channelMap[channel], true);
        }
    }
    trySubscribe(channel) {
        const meetsAuthRequirements = !channel.options.waitForAuth || !!this._transport.signedAuthToken;
        // We can only ever have one pending subscribe action at any given time on a channel
        if (this._transport.status === 'ready' &&
            !this._preparingPendingSubscriptions &&
            !channel.subscribePromise &&
            meetsAuthRequirements) {
            const subscriptionOptions = {};
            if (channel.options.waitForAuth) {
                subscriptionOptions.waitForAuth = true;
            }
            if (channel.options.data) {
                subscriptionOptions.data = channel.options.data;
            }
            [channel.subscribePromise, channel.subscribeAbort] = this._transport.invoke({ method: '#subscribe', ackTimeoutMs: false }, {
                channel: this.decorateChannelName(channel.name),
                ...subscriptionOptions
            });
            channel.subscribePromise.then(() => {
                delete channel.subscribePromise;
                delete channel.subscribeAbort;
                this.triggerChannelSubscribe(channel, subscriptionOptions);
            }).catch(err => {
                if (err.name === 'BadConnectionError') {
                    // In case of a failed connection, keep the subscription
                    // as pending; it will try again on reconnect.
                    return;
                }
                if (err.name !== 'AbortError') {
                    this.triggerChannelSubscribeFail(err, channel, subscriptionOptions);
                }
                delete channel.subscribePromise;
                delete channel.subscribeAbort;
            });
            this.emit('subscribeRequest', {
                channel: channel.name,
                options: subscriptionOptions
            });
        }
    }
    processPendingSubscriptions() {
        this._preparingPendingSubscriptions = false;
        const pendingChannels = [];
        Object.keys(this._channelMap).forEach((channelName) => {
            const channel = this._channelMap[channelName];
            if (channel.state === 'pending') {
                pendingChannels.push(channel);
            }
        });
        pendingChannels.sort((a, b) => {
            const ap = a.options.priority || 0;
            const bp = b.options.priority || 0;
            if (ap > bp) {
                return -1;
            }
            if (ap < bp) {
                return 1;
            }
            return 0;
        });
        pendingChannels.forEach((channel) => {
            this.trySubscribe(channel);
        });
    }
    unsubscribe(channelName) {
        const channel = this._channelMap[channelName];
        if (channel) {
            this.tryUnsubscribe(channel);
        }
    }
    tryUnsubscribe(channel) {
        this.triggerChannelUnsubscribe(channel);
        if (this._transport.status === 'ready') {
            // If there is a pending subscribe action, cancel the callback
            this.cancelPendingSubscribeCallback(channel);
            const decoratedChannelName = this.decorateChannelName(channel.name);
            // This operation cannot fail because the TCP protocol guarantees delivery
            // so long as the connection remains open. If the connection closes,
            // the server will automatically unsubscribe the client and thus complete
            // the operation on the server side.
            this._transport
                .transmit('#unsubscribe', decoratedChannelName)
                .catch(err => { });
        }
    }
    triggerChannelSubscribeFail(err, channel, options) {
        const meetsAuthRequirements = !channel.options.waitForAuth || !!this._transport.signedAuthToken;
        const hasChannel = !!this._channelMap[channel.name];
        if (hasChannel && meetsAuthRequirements) {
            delete this._channelMap[channel.name];
            this._channelEventDemux.write(`${channel.name}/subscribeFail`, {
                channel: channel.name,
                error: err,
                options
            });
            this.emit('subscribeFail', {
                error: err,
                channel: channel.name,
                options
            });
        }
    }
    transmitPublish(channelName, data) {
        const pubData = {
            channel: this.decorateChannelName(channelName),
            data
        };
        return this._transport.transmit('#publish', pubData);
    }
    invokePublish(channelName, data) {
        const pubData = {
            channel: this.decorateChannelName(channelName),
            data
        };
        return this._transport.invoke('#publish', pubData)[0];
    }
}

function isRequestPacket(packet) {
    return (typeof packet === 'object') && 'method' in packet;
}

function wait(duration) {
    return new Promise((resolve) => {
        setTimeout(() => {
            resolve();
        }, duration);
    });
}
function toArray(arr) {
    return Array.isArray(arr) ? arr : [arr];
}

function abortRequest(request, err) {
    if (request.sentCallback) {
        request.sentCallback(err);
    }
    if ('callback' in request && request.callback) {
        request.callback(err);
    }
}
function isRequestDone(request) {
    if ('callback' in request) {
        return (request.callback === null);
    }
    return !request.sentCallback;
}

// Based on https://github.com/dscape/cycle/blob/master/cycle.js
// Make a deep copy of an object or array, assuring that there is at most
// one instance of each object or array in the resulting structure. The
// duplicate references (which might be forming cycles) are replaced with
// an object of the form
//      {$ref: PATH}
// where the PATH is a JSONPath string that locates the first occurance.
// So,
//      var a = [];
//      a[0] = a;
//      return JSON.stringify(JSON.decycle(a));
// produces the string '[{"$ref":"$"}]'.
// JSONPath is used to locate the unique object. $ indicates the top level of
// the object or array. [NUMBER] or [STRING] indicates a child member or
// property.
function decycle(object) {
    var objects = [], // Keep a reference to each unique object or array
    paths = []; // Keep the path to each unique object or array
    return (function derez(value, path) {
        // The derez recurses through the object, producing the deep copy.
        var i, // The loop counter
        name, // Property name
        nu;
        // typeof null === 'object', so go on if this value is really an object but not
        // one of the weird builtin objects.
        if (typeof value === 'object' && value !== null &&
            !(value instanceof Boolean) &&
            !(value instanceof Date) &&
            !(value instanceof Number) &&
            !(value instanceof RegExp) &&
            !(value instanceof String)) {
            // If the value is an object or array, look to see if we have already
            // encountered it. If so, return a $ref/path object. This is a hard way,
            // linear search that will get slower as the number of unique objects grows.
            for (i = 0; i < objects.length; i += 1) {
                if (objects[i] === value) {
                    return { $ref: paths[i] };
                }
            }
            // Otherwise, accumulate the unique value and its path.	
            objects.push(value);
            paths.push(path);
            // If it is an array, replicate the array.
            if (Object.prototype.toString.apply(value) === '[object Array]') {
                nu = [];
                for (i = 0; i < value.length; i += 1) {
                    nu[i] = derez(value[i], path + '[' + i + ']');
                }
            }
            else {
                // If it is an object, replicate the object.
                nu = {};
                for (name in value) {
                    if (Object.prototype.hasOwnProperty.call(value, name)) {
                        nu[name] = derez(value[name], path + '[' + JSON.stringify(name) + ']');
                    }
                }
            }
            return nu;
        }
        return value;
    }(object, '$'));
}

class AbortError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AbortError';
        Object.setPrototypeOf(this, AbortError.prototype);
    }
}
class PluginBlockedError extends Error {
    constructor(message, type) {
        super(message);
        this.name = 'PluginBlockedError';
        this.type = type;
        Object.setPrototypeOf(this, PluginBlockedError.prototype);
    }
}
class InvalidActionError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidActionError';
        Object.setPrototypeOf(this, InvalidActionError.prototype);
    }
}
class InvalidArgumentsError extends Error {
    constructor(message) {
        super(message);
        this.name = 'InvalidArgumentsError';
        Object.setPrototypeOf(this, InvalidArgumentsError.prototype);
    }
}
class SocketProtocolError extends Error {
    constructor(message, code) {
        super(message);
        this.name = 'SocketProtocolError';
        this.code = code;
        Object.setPrototypeOf(this, SocketProtocolError.prototype);
    }
}
class TimeoutError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TimeoutError';
        Object.setPrototypeOf(this, TimeoutError.prototype);
    }
}
class BadConnectionError extends Error {
    constructor(message, type) {
        super(message);
        this.name = 'BadConnectionError';
        this.type = type;
        Object.setPrototypeOf(this, BadConnectionError.prototype);
    }
}
const socketProtocolErrorStatuses = {
    1001: 'Socket was disconnected',
    1002: 'A WebSocket protocol error was encountered',
    1003: 'Server terminated socket because it received invalid data',
    1005: 'Socket closed without status code',
    1006: 'Socket hung up',
    1007: 'Message format was incorrect',
    1008: 'Encountered a policy violation',
    1009: 'Message was too big to process',
    1010: 'Client ended the connection because the server did not comply with extension requirements',
    1011: 'Server encountered an unexpected fatal condition',
    4000: 'Server ping timed out',
    4001: 'Client pong timed out',
    4002: 'Server failed to sign auth token',
    4003: 'Failed to complete handshake',
    4004: 'Client failed to save auth token',
    4005: 'Did not receive #handshake from client before timeout',
    4006: 'Failed to bind socket to message broker',
    4007: 'Client connection establishment timed out',
    4008: 'Server rejected handshake from client',
    4009: 'Server received a message before the client handshake'
};
const socketProtocolIgnoreStatuses = {
    1000: 'Socket closed normally',
    1001: 'Socket hung up'
};
// Convert an error into a JSON-compatible type which can later be hydrated
// back to its *original* form.
function dehydrateError(error) {
    let dehydratedError;
    if (error && typeof error === 'object') {
        dehydratedError = {
            message: error.message
        };
        for (let i of Object.keys(error)) {
            dehydratedError[i] = error[i];
        }
    }
    else if (typeof error === 'function') {
        dehydratedError = '[function ' + (typeof error.name === 'string' ? error.name : 'anonymous') + ']';
    }
    else {
        dehydratedError = error;
    }
    return decycle(dehydratedError);
}
// Convert a dehydrated error back to its *original* form.
function hydrateError(error) {
    let hydratedError = null;
    if (error != null) {
        if (typeof error === 'object') {
            hydratedError = new Error(typeof error.message === 'string' ? error.message : 'Invalid error message format');
            if (typeof error.name === 'string') {
                hydratedError.name = error.name;
            }
            for (let i of Object.keys(error)) {
                if (hydratedError[i] === undefined) {
                    hydratedError[i] = error[i];
                }
            }
        }
        else {
            hydratedError = error;
        }
    }
    return hydratedError;
}

class RequestHandlerArgs {
    constructor(options) {
        this.isRpc = options.isRpc;
        this.method = options.method;
        this.options = options.options;
        this.requestedAt = new Date();
        this.socket = options.socket;
        this.transport = options.transport;
        this.timeoutMs = options.timeoutMs;
    }
    checkTimeout(timeLeftMs = 0) {
        if (typeof this.timeoutMs === 'number' && this.getRemainingTimeMs() <= timeLeftMs) {
            throw new TimeoutError(`Method \'${this.method}\' timed out.`);
        }
    }
    getRemainingTimeMs() {
        if (typeof this.timeoutMs === 'number') {
            return (this.requestedAt.valueOf() + this.timeoutMs) - new Date().valueOf();
        }
        return Infinity;
    }
}

function isResponsePacket(packet) {
    return (typeof packet === 'object') && 'rid' in packet;
}

class Socket extends AsyncStreamEmitter {
    constructor(transport, options) {
        super();
        this.state = options?.state || {};
        transport.socket = this;
        this._transport = transport;
    }
    get id() {
        return this._transport.id;
    }
    get authToken() {
        return this._transport.authToken;
    }
    get signedAuthToken() {
        return this._transport.signedAuthToken;
    }
    deauthenticate() {
        return this._transport.changeToUnauthenticatedState();
    }
    disconnect(code = 1000, reason) {
        this._transport.disconnect(code, reason);
    }
    getBackpressure() {
        return Math.max(this._transport.getBackpressure(), this.getListenerBackpressure());
    }
    getInboundBackpressure() {
        return this._transport.getInboundBackpressure();
    }
    getOutboundBackpressure() {
        return this._transport.getOutboundBackpressure();
    }
    emit(event, data) {
        super.emit(event, data);
    }
    listen(event) {
        return super.listen(event);
    }
    get status() {
        return this._transport.status;
    }
    get url() {
        return this._transport.url;
    }
    transmit(serviceAndMethod, arg) {
        return this._transport.transmit(serviceAndMethod, arg);
    }
    invoke(methodOptions, arg) {
        return this._transport.invoke(methodOptions, arg)[0];
    }
}

const base64Chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const validJSONStartRegex = /^[ \n\r\t]*[{\[]/;
function arrayBufferToBase64(arraybuffer) {
    const bytes = new Uint8Array(arraybuffer);
    const len = bytes.length;
    let base64 = '';
    for (let i = 0; i < len; i += 3) {
        base64 += base64Chars[bytes[i] >> 2];
        base64 += base64Chars[((bytes[i] & 3) << 4) | (bytes[i + 1] >> 4)];
        base64 += base64Chars[((bytes[i + 1] & 15) << 2) | (bytes[i + 2] >> 6)];
        base64 += base64Chars[bytes[i + 2] & 63];
    }
    if ((len % 3) === 2) {
        base64 = base64.substring(0, base64.length - 1) + '=';
    }
    else if (len % 3 === 1) {
        base64 = base64.substring(0, base64.length - 2) + '==';
    }
    return base64;
}
function binaryToBase64Replacer(key, value) {
    if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) {
        return {
            base64: true,
            data: arrayBufferToBase64(value)
        };
    }
    else if (typeof Buffer !== 'undefined') {
        if (value instanceof Buffer) {
            return {
                base64: true,
                data: value.toString('base64')
            };
        }
        // Some versions of Node.js convert Buffers to Objects before they are passed to
        // the replacer function - Because of this, we need to rehydrate Buffers
        // before we can convert them to base64 strings.
        if (value && value.type === 'Buffer' && Array.isArray(value.data)) {
            let rehydratedBuffer;
            if (Buffer.from) {
                rehydratedBuffer = Buffer.from(value.data);
            }
            else {
                rehydratedBuffer = new Buffer(value.data);
            }
            return {
                base64: true,
                data: rehydratedBuffer.toString('base64')
            };
        }
    }
    return value;
}
class DefaultCodec {
    // Decode the data which was transmitted over the wire to a JavaScript Object in a format which SC understands.
    // See encode function below for more details.
    decode(encodedMessage) {
        if (encodedMessage == null) {
            return null;
        }
        // Leave ping or pong message as is
        if (encodedMessage === '#1' || encodedMessage === '#2') {
            return encodedMessage;
        }
        const message = encodedMessage.toString();
        // Performance optimization to detect invalid JSON packet sooner.
        if (!validJSONStartRegex.test(message)) {
            return message;
        }
        try {
            return JSON.parse(message);
        }
        catch (err) { }
        return message;
    }
    // Encode raw data (which is in the SM protocol format) into a format for
    // transfering it over the wire. In this case, we just convert it into a simple JSON string.
    // If you want to create your own custom codec, you can encode the object into any format
    // (e.g. binary ArrayBuffer or string with any kind of compression) so long as your decode
    // function is able to rehydrate that object back into its original JavaScript Object format
    // (which adheres to the SM protocol).
    // See https://github.com/SocketCluster/socketcluster/blob/master/socketcluster-protocol.md
    // for details about the SM protocol.
    encode(rawData) {
        // Leave ping or pong message as is
        if (rawData === '#1' || rawData === '#2') {
            return rawData;
        }
        return JSON.stringify(rawData, binaryToBase64Replacer);
    }
}
const defaultCodec = new DefaultCodec();

// https://github.com/maxogden/websocket-stream/blob/48dc3ddf943e5ada668c31ccd94e9186f02fafbd/ws-fallback.js

var ws = null;

if (typeof WebSocket !== 'undefined') {
  ws = WebSocket;
} else if (typeof MozWebSocket !== 'undefined') {
  ws = MozWebSocket;
} else if (typeof global !== 'undefined') {
  ws = global.WebSocket || global.MozWebSocket;
} else if (typeof window !== 'undefined') {
  ws = window.WebSocket || window.MozWebSocket;
} else if (typeof self !== 'undefined') {
  ws = self.WebSocket || self.MozWebSocket;
}

var ws$1 = ws;

var AuthState;
(function (AuthState) {
    AuthState["AUTHENTICATED"] = "authenticated";
    AuthState["UNAUTHENTICATED"] = "unauthenticated";
})(AuthState || (AuthState = {}));

function extractAuthTokenData(signedAuthToken) {
    if (typeof signedAuthToken !== 'string')
        return null;
    let tokenParts = signedAuthToken.split('.');
    let encodedTokenData = tokenParts[1];
    if (encodedTokenData != null) {
        let tokenData = encodedTokenData;
        try {
            tokenData = Buffer.from(tokenData, 'base64').toString('utf8');
            return JSON.parse(tokenData);
        }
        catch (e) {
            return tokenData;
        }
    }
    return null;
}

class SocketTransport {
    constructor(options) {
        let cid = 1;
        this.ackTimeoutMs = options?.ackTimeoutMs ?? 10000;
        this._callIdGenerator = options?.callIdGenerator || (() => {
            return cid++;
        });
        this._callbackMap = {};
        this.codecEngine = options?.codecEngine || defaultCodec;
        this._handlers = options?.handlers || {};
        this.id = null;
        this._inboundProcessedMessageCount = 0;
        this._inboundReceivedMessageCount = 0;
        this._outboundPreparedMessageCount = 0;
        this._outboundSentMessageCount = 0;
        this._pingTimeoutRef = null;
        this.plugins = options?.plugins || [];
        this.streamCleanupMode = options?.streamCleanupMode || 'kill';
    }
    abortAllPendingCallbacksDueToBadConnection(status) {
        for (const cid in this._callbackMap) {
            const map = this._callbackMap[cid];
            const msg = `Event ${map.method} was aborted due to a bad connection`;
            map.callback(new BadConnectionError(msg, status === 'ready' ? 'disconnect' : 'connectAbort'));
        }
    }
    get authToken() {
        return this._authToken;
    }
    async changeToUnauthenticatedState() {
        if (this._signedAuthToken) {
            const authToken = this._authToken;
            const signedAuthToken = this._signedAuthToken;
            this._authToken = null;
            this._signedAuthToken = null;
            this._socket.emit('authStateChange', { wasAuthenticated: true, isAuthenticated: false });
            // In order for the events to trigger we need to wait for the next tick.
            await wait(0);
            this._socket.emit('deauthenticate', { signedAuthToken, authToken });
            for (const plugin of this.plugins) {
                if (plugin.onDeauthenticate) {
                    plugin.onDeauthenticate({ socket: this.socket, transport: this });
                }
            }
            return true;
        }
        return false;
    }
    decode(data) {
        try {
            return this.codecEngine.decode(data);
        }
        catch (err) {
            if (err.name === 'Error') {
                err.name = 'InvalidMessageError';
            }
            this.onError(err);
            return null;
        }
    }
    disconnect(code = 1000, reason) {
        if (this.webSocket) {
            this.webSocket.close(code, reason);
            this.onClose(code, reason);
        }
    }
    getBackpressure() {
        return Math.max(this.getInboundBackpressure(), this.getOutboundBackpressure());
    }
    getInboundBackpressure() {
        return this._inboundReceivedMessageCount - this._inboundProcessedMessageCount;
    }
    getOutboundBackpressure() {
        return this._outboundPreparedMessageCount - this._outboundSentMessageCount;
    }
    async handleInboudMessage({ packet, timestamp }) {
        if (packet === null) {
            return;
        }
        packet = toArray(packet);
        for (let curPacket of packet) {
            let pluginError;
            try {
                for (const plugin of this.plugins) {
                    if (plugin.onMessage) {
                        curPacket = await plugin.onMessage({ socket: this.socket, transport: this, packet: curPacket, timestamp: timestamp });
                    }
                }
            }
            catch (err) {
                pluginError = err;
            }
            // Check to see if it is a request or response packet. 
            if (isResponsePacket(curPacket)) {
                this.onResponse(curPacket, pluginError);
            }
            else if (isRequestPacket(curPacket)) {
                await this.onRequest(curPacket, timestamp, pluginError);
            }
            else ;
        }
    }
    onClose(code, reason) {
        const prevStatus = this.status;
        this.webSocket = null;
        this._isReady = false;
        clearTimeout(this._pingTimeoutRef);
        this._pingTimeoutRef = null;
        this.abortAllPendingCallbacksDueToBadConnection(prevStatus);
        for (const plugin of this.plugins) {
            if (plugin.onClose) {
                plugin.onClose({ socket: this.socket, transport: this });
            }
        }
        if (!socketProtocolIgnoreStatuses[code]) {
            let closeMessage;
            if (typeof reason === 'string') {
                closeMessage = `Socket connection closed with status code ${code} and reason: ${reason}`;
            }
            else {
                closeMessage = `Socket connection closed with status code ${code}`;
            }
            this.onError(new SocketProtocolError(socketProtocolErrorStatuses[code] || closeMessage, code));
        }
        const strReason = reason?.toString() || socketProtocolErrorStatuses[code];
        this._socket.emit('close', { code, reason: strReason });
    }
    onDisconnect(status, code, reason) {
        if (status === 'ready') {
            this._socket.emit('disconnect', { code, reason });
        }
        else {
            this._socket.emit('connectAbort', { code, reason });
        }
        for (const plugin of this.plugins) {
            if (plugin.onDisconnected) {
                plugin.onDisconnected({ socket: this.socket, transport: this, status, code, reason });
            }
        }
    }
    onError(error) {
        this._socket.emit('error', { error });
    }
    onInvoke(request) {
        this.sendRequest([request]);
    }
    onMessage(data, isBinary) {
        data = isBinary ? data : data.toString();
        if (data === '') {
            this.onPingPong();
            return;
        }
        const timestamp = new Date();
        let p = Promise.resolve(data);
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
            resolve = res;
            reject = rej;
        });
        this._inboundReceivedMessageCount++;
        for (let i = 0; i < this.plugins.length; i++) {
            const plugin = this.plugins[i];
            if (plugin.onMessageRaw) {
                p = p.then(message => {
                    return plugin.onMessageRaw({ socket: this.socket, transport: this, message, timestamp, promise });
                });
            }
        }
        p.then(data => {
            const packet = this.decode(data);
            this._socket.emit('message', { data, isBinary });
            return this.handleInboudMessage({ packet, timestamp });
        })
            .then(resolve)
            .catch(err => {
            reject(err);
            if (!(err instanceof PluginBlockedError)) {
                this.onError(err);
            }
        }).finally(() => {
            this._inboundProcessedMessageCount++;
        });
    }
    onOpen() {
        // Placeholder for inherited classes
        for (const plugin of this.plugins) {
            if (plugin.onOpen) {
                plugin.onOpen({ socket: this.socket, transport: this });
            }
        }
    }
    onPingPong() { }
    async onRequest(packet, timestamp, pluginError) {
        this._socket.emit('request', { request: packet });
        const timeoutAt = typeof packet.ackTimeoutMs === 'number' ? new Date(timestamp.valueOf() + packet.ackTimeoutMs) : null;
        let wasHandled = false;
        let response;
        let error;
        if (pluginError) {
            wasHandled = true;
            error = pluginError;
            response = { rid: packet.cid, timeoutAt, error: pluginError };
        }
        else {
            const handler = this._handlers[packet.method];
            if (handler) {
                wasHandled = true;
                try {
                    const data = await handler(new RequestHandlerArgs({
                        isRpc: !!packet.cid,
                        method: packet.method.toString(),
                        timeoutMs: packet.ackTimeoutMs,
                        socket: this._socket,
                        transport: this,
                        options: packet.data
                    }));
                    if (packet.cid) {
                        response = { rid: packet.cid, timeoutAt, data };
                    }
                }
                catch (err) {
                    error = err;
                    if (packet.cid) {
                        response = { rid: packet.cid, timeoutAt, error };
                    }
                }
            }
        }
        if (response) {
            this.sendResponse([response]);
        }
        if (error) {
            this.onError(error);
        }
        if (!wasHandled) {
            wasHandled = this.onUnhandledRequest(packet);
        }
        return wasHandled;
    }
    onResponse(response, pluginError) {
        const map = this._callbackMap[response.rid];
        if (map) {
            if (map.timeoutId) {
                clearTimeout(map.timeoutId);
                delete map.timeoutId;
            }
            if (pluginError) {
                map.callback(pluginError);
            }
            else if ('error' in response) {
                map.callback(hydrateError(response.error));
            }
            else {
                map.callback(null, 'data' in response ? response.data : undefined);
            }
        }
        if (pluginError) {
            this._socket.emit('response', { response: { rid: response.rid, error: pluginError } });
        }
        else {
            this._socket.emit('response', { response });
        }
    }
    onSocketClose(event) {
        this.onClose(event.code, event.reason);
    }
    onSocketError(event) {
        this.onError(event.error);
    }
    onSocketMessage(event) {
        this.onMessage(event.data, false);
    }
    onTransmit(request) {
        this.sendRequest([request]);
    }
    onUnhandledRequest(packet) {
        if (this._onUnhandledRequest) {
            return this._onUnhandledRequest(this, packet);
        }
        return false;
    }
    resetPingTimeout(timeoutMs, code) {
        if (this._pingTimeoutRef) {
            clearTimeout(this._pingTimeoutRef);
            this._pingTimeoutRef = null;
        }
        if (timeoutMs !== false) {
            // Use `WebSocket#terminate()`, which immediately destroys the connection,
            // instead of `WebSocket#close()`, which waits for the close timer.
            // Delay should be equal to the interval at which your server
            // sends out pings plus a conservative assumption of the latency.
            this._pingTimeoutRef = setTimeout(() => {
                this.webSocket.close(code);
            }, timeoutMs);
        }
    }
    send(data) {
        return new Promise((resolve, reject) => {
            try {
                this._webSocket.send(data, (err) => {
                    if (err) {
                        reject(err);
                        return;
                    }
                    resolve();
                });
            }
            catch (err) {
                throw err;
            }
        });
    }
    sendRequest(index, requests) {
        if (typeof index === 'object') {
            requests = index;
            index = 0;
        }
        // Filter out any requests that have already timed out.
        if (requests.some(request => isRequestDone(request))) {
            requests = requests.filter(req => isRequestDone(req));
            if (!requests.length) {
                return;
            }
        }
        for (; index < this.plugins.length; index++) {
            const plugin = this.plugins[index];
            if ('sendRequest' in plugin) {
                index++;
                try {
                    plugin.sendRequest({
                        socket: this.socket,
                        transport: this,
                        requests,
                        cont: this.sendRequest.bind(this, index)
                    });
                }
                catch (err) {
                    for (const req of requests) {
                        abortRequest(req, err);
                    }
                }
                return;
            }
        }
        // If the socket is closed we need to call them back with an error.
        if (this.status === 'closed') {
            for (const req of requests) {
                const err = new BadConnectionError(`Socket ${'callback' in req ? 'invoke' : 'transmit'} ${String(req.method)} event was aborted due to a bad connection`, 'connectAbort');
                this.onError(err);
                abortRequest(req, err);
            }
            return;
        }
        const encode = requests.map(req => {
            if ('callback' in req) {
                const { callback, promise, timeoutId, ...rest } = req;
                this._callbackMap[req.cid] = {
                    method: ['service' in req ? req.service : '', req.method].filter(Boolean).join('.'),
                    timeoutId: req.timeoutId,
                    callback: req.callback
                };
                return rest;
            }
            const { promise, ...rest } = req;
            return rest;
        });
        let sendErr;
        this.send(this.codecEngine.encode(encode.length === 1 ? encode[0] : encode)).catch(err => {
            sendErr = err;
        }).then(() => {
            const errCode = sendErr?.code;
            for (const req of requests) {
                if (errCode === 'ECONNRESET') {
                    sendErr = new BadConnectionError(`Socket ${'callback' in req ? 'invoke' : 'transmit'} ${String(req.method)} event was aborted due to a bad connection`, 'connectAbort');
                }
                if (req.sentCallback) {
                    req.sentCallback(sendErr);
                }
                if (sendErr && 'callback' in req) {
                    req.callback(sendErr);
                }
            }
        }).catch(err => {
            this.onError(err);
        });
    }
    sendResponse(index, responses) {
        if (typeof index === 'object') {
            responses = index;
            index = 0;
        }
        // Remove any response that has timed out
        if (!(responses = responses.filter(item => !item.timeoutAt || item.timeoutAt > new Date())).length) {
            return;
        }
        for (; index < this.plugins.length; index++) {
            const plugin = this.plugins[index];
            if ('sendResponse' in plugin) {
                index++;
                try {
                    plugin.sendResponse({
                        socket: this.socket,
                        transport: this,
                        responses,
                        cont: this.sendResponse.bind(this, index)
                    });
                }
                catch (err) {
                    this.sendResponse(index, responses.map(item => ({ rid: item.rid, timeoutAt: item.timeoutAt, error: err })));
                }
                return;
            }
        }
        // If the socket is closed we need to call them back with an error.
        if (this.status === 'closed') {
            for (const response of responses) {
                this.onError(new Error(`WebSocket is not open: readyState 3 (CLOSED)`));
            }
            return;
        }
        for (const response of responses) {
            if ('error' in response) {
                response.error = dehydrateError(response.error);
            }
            delete response.timeoutAt;
        }
        //timeoutId?: NodeJS.Timeout;
        //callback: (err: Error, result?: U) => void | null
        this.send(this.codecEngine.encode(responses.length === 1 ? responses[0] : responses)).catch(err => {
            this.onError(err);
        });
    }
    async setAuthorization(signedAuthToken, authToken) {
        if (typeof signedAuthToken !== 'string') {
            throw new InvalidArgumentsError('SignedAuthToken must be type string.');
        }
        if (signedAuthToken !== this._signedAuthToken) {
            if (!authToken) {
                const extractedAuthToken = extractAuthTokenData(signedAuthToken);
                if (typeof extractedAuthToken === 'string') {
                    throw new InvalidArgumentsError('Invalid authToken.');
                }
                authToken = extractedAuthToken;
            }
            this._authToken = authToken;
            this._signedAuthToken = signedAuthToken;
            return true;
        }
        return false;
    }
    setReadyStatus(pingTimeoutMs, authError) {
        if (this._webSocket?.readyState !== ws$1.OPEN) {
            throw new InvalidActionError('Cannot set status to OPEN before socket is connected.');
        }
        this._isReady = true;
        for (const plugin of this.plugins) {
            if (plugin.onReady) {
                plugin.onReady({ socket: this.socket, transport: this });
            }
        }
        this._socket.emit('connect', { id: this.id, pingTimeoutMs, isAuthenticated: !!this.signedAuthToken, authError });
    }
    get signedAuthToken() {
        return this._signedAuthToken;
    }
    get socket() {
        return this._socket;
    }
    set socket(value) {
        this._socket = value;
    }
    get status() {
        if (!this._webSocket) {
            return 'closed';
        }
        if (this._isReady) {
            return 'ready';
        }
        switch (this._webSocket.readyState) {
            case ws$1.CONNECTING:
            case ws$1.OPEN:
                return 'connecting';
            case ws$1.CLOSING:
                return 'closing';
            default:
                return 'closed';
        }
    }
    triggerAuthenticationEvents(wasSigned, wasAuthenticated) {
        this._socket.emit('authStateChange', { wasAuthenticated, isAuthenticated: true, authToken: this._authToken, signedAuthToken: this._signedAuthToken });
        this._socket.emit('authenticate', { wasSigned, signedAuthToken: this._signedAuthToken, authToken: this._authToken });
        for (const plugin of this.plugins) {
            if (plugin.onAuthenticated) {
                plugin.onAuthenticated({ socket: this.socket, transport: this });
            }
        }
    }
    transmit(serviceAndMethod, arg) {
        let service;
        let serviceMethod;
        let method;
        if (Array.isArray(serviceAndMethod)) {
            service = serviceAndMethod[0];
            serviceMethod = serviceAndMethod[1];
        }
        else {
            method = serviceAndMethod;
        }
        const request = service ? {
            service,
            method: serviceMethod,
            promise: null,
            data: arg
        } : {
            data: arg,
            method,
            promise: null
        };
        const promise = request.promise = new Promise((resolve, reject) => {
            request.sentCallback = (err) => {
                delete request.sentCallback;
                this._outboundSentMessageCount++;
                if (err) {
                    reject(err);
                    return;
                }
                resolve();
            };
        });
        this._outboundPreparedMessageCount++;
        this.onTransmit(request);
        return promise;
    }
    invoke(methodOptions, arg) {
        let service;
        let serviceMethod;
        let method;
        let ackTimeoutMs;
        if (typeof methodOptions === 'object') {
            if (Array.isArray(methodOptions)) {
                service = methodOptions[0];
                serviceMethod = methodOptions[1];
                ackTimeoutMs = methodOptions[2];
            }
            else {
                if ('service' in methodOptions) {
                    service = methodOptions.service;
                    serviceMethod = methodOptions.method;
                }
                else {
                    method = methodOptions.method;
                }
                ackTimeoutMs = methodOptions.ackTimeoutMs;
            }
        }
        else {
            method = methodOptions;
        }
        let callbackMap = this._callbackMap;
        const request = Object.assign({
            cid: this._callIdGenerator(),
            ackTimeoutMs: ackTimeoutMs ?? this.ackTimeoutMs,
            callback: null,
            promise: null
        }, service ? {
            service,
            method: serviceMethod,
            data: arg
        } : {
            method: method,
            data: arg
        });
        let abort;
        const promise = request.promise = new Promise((resolve, reject) => {
            if (request.ackTimeoutMs) {
                request.timeoutId = setTimeout(() => {
                    delete callbackMap[request.cid];
                    request.callback = null;
                    clearTimeout(request.timeoutId);
                    delete request.timeoutId;
                    reject(new TimeoutError(`Method \'${[service, request.method].filter(Boolean).join('.')}\' timed out.`));
                }, request.ackTimeoutMs);
            }
            abort = () => {
                delete callbackMap[request.cid];
                if (request.timeoutId) {
                    clearTimeout(request.timeoutId);
                    delete request.timeoutId;
                }
                if (request.callback) {
                    request.callback = null;
                    reject(new AbortError(`Method \'${[service, request.method].filter(Boolean).join('.')}\' was aborted.`));
                }
            };
            request.callback = (err, result) => {
                delete callbackMap[request.cid];
                request.callback = null;
                if (request.timeoutId) {
                    clearTimeout(request.timeoutId);
                    delete request.timeoutId;
                }
                if (err) {
                    reject(err);
                    return;
                }
                resolve(result);
            };
            request.sentCallback = () => {
                delete request.sentCallback;
                this._outboundSentMessageCount++;
            };
        });
        this._outboundPreparedMessageCount++;
        this.onInvoke(request);
        return [promise, abort];
    }
    get url() {
        return this._webSocket.url;
    }
    get webSocket() {
        return this._webSocket;
    }
    set webSocket(value) {
        if (this._webSocket) {
            this._webSocket.onclose = null;
            this._webSocket.onerror = null;
            this._webSocket.onmessage = null;
            this._webSocket.onopen = null;
            delete this.onSocketClose;
            delete this.onSocketError;
            delete this.onSocketMessage;
            delete this.onOpen;
        }
        this._webSocket = value;
        if (value) {
            this._webSocket.onclose = this.onSocketClose = this.onSocketClose.bind(this);
            this._webSocket.onopen = this.onOpen = this.onOpen.bind(this);
            this._webSocket.onerror = this.onSocketError = this.onSocketError.bind(this);
            this._webSocket.onmessage = this.onSocketMessage = this.onSocketMessage.bind(this);
        }
    }
}

class ClientTransport extends SocketTransport {
    constructor(options) {
        super(options);
        this.type = 'client';
        this._uri = typeof options.address === 'string' ? new URL(options.address) : options.address;
        this.authEngine =
            isAuthEngine(options.authEngine) ?
                options.authEngine :
                new LocalStorageAuthEngine(Object.assign({ authTokenName: `socketmesh.authToken${this._uri.protocol}${this._uri.hostname}` }, options.authEngine));
        this.connectTimeoutMs = options.connectTimeoutMs ?? 20000;
        this._pingTimeoutMs = this.connectTimeoutMs;
        if (options.wsOptions) {
            this._wsOptions = options.wsOptions;
        }
        this._connectAttempts = 0;
        this._pendingReconnectTimeout = null;
        this.autoReconnect = options.autoReconnect;
        this.isPingTimeoutDisabled = (options.isPingTimeoutDisabled === true);
    }
    get autoReconnect() {
        return this._autoReconnect;
    }
    set autoReconnect(value) {
        if (value) {
            this._autoReconnect = Object.assign({
                initialDelay: 10000,
                randomness: 10000,
                multiplier: 1.5,
                maxDelayMs: 60000
            }, value === true ? {} : value);
        }
        else {
            this._autoReconnect = false;
        }
    }
    connect(options) {
        let timeoutMs = this.connectTimeoutMs;
        if (options) {
            let changeOptions = false;
            if (options.connectTimeoutMs) {
                timeoutMs = options.connectTimeoutMs;
            }
            if (options.address) {
                changeOptions = true;
                this._uri = typeof options.address === 'string' ? new URL(options.address) : options.address;
            }
            if (options.wsOptions) {
                changeOptions = true;
                this._wsOptions = options.wsOptions;
            }
            if (changeOptions && this.status !== 'closed') {
                this.disconnect(1000, 'Socket was disconnected by the client to initiate a new connection');
            }
        }
        if (this.status === 'closed') {
            this.webSocket = new ws$1(this._uri, this._wsOptions);
            this.socket.emit('connecting', {});
            this._connectTimeoutRef = setTimeout(() => {
                this.disconnect(4007);
            }, timeoutMs);
        }
    }
    get connectAttempts() {
        return this._connectAttempts;
    }
    disconnect(code = 1000, reason) {
        if (code !== 4007) {
            this.resetReconnect();
        }
        super.disconnect(code, reason);
    }
    async handshake() {
        const token = await this.authEngine.loadToken();
        // Don't wait for this.state to be 'ready'.
        // The underlying WebSocket (this.socket) is already open.
        // The casting to HandshakeStatus has to be here or typescript freaks out
        const status = await this.invoke('#handshake', { authToken: token })[0];
        if ('authError' in status) {
            status.authError = hydrateError(status.authError);
        }
        return status;
    }
    onClose(code, reason) {
        const status = this.status;
        let reconnecting = false;
        super.onClose(code, reason);
        // Try to reconnect
        // on server ping timeout (4000)
        // or on client pong timeout (4001)
        // or on close without status (1005)
        // or on handshake failure (4003)
        // or on handshake rejection (4008)
        // or on socket hung up (1006)
        if (this.autoReconnect) {
            if (code === 4000 || code === 4001 || code === 1005) {
                // If there is a ping or pong timeout or socket closes without
                // status, don't wait before trying to reconnect - These could happen
                // if the client wakes up after a period of inactivity and in this case we
                // want to re-establish the connection as soon as possible.
                reconnecting = !!this.autoReconnect;
                this.tryReconnect(0);
                // Codes 4500 and above will be treated as permanent disconnects.
                // Socket will not try to auto-reconnect.
            }
            else if (code !== 1000 && code < 4500) {
                reconnecting = !!this.autoReconnect;
                this.tryReconnect();
            }
        }
        if (!reconnecting) {
            const strReason = reason?.toString() || socketProtocolErrorStatuses[code];
            this.onDisconnect(status, code, strReason);
        }
    }
    onOpen() {
        super.onOpen();
        clearTimeout(this._connectTimeoutRef);
        this._connectTimeoutRef = null;
        this.resetReconnect();
        this.resetPingTimeout(this.isPingTimeoutDisabled ? false : this.pingTimeoutMs, 4000);
        let authError;
        this.handshake()
            .then(status => {
            this.id = status.id;
            this.pingTimeoutMs = status.pingTimeoutMs;
            if ('authToken' in status && status.authToken) {
                return this.setAuthorization(status.authToken);
            }
            if ('authError' in status) {
                authError = status.authError;
            }
            return this.changeToUnauthenticatedState();
        })
            .then(() => {
            this.setReadyStatus(this.pingTimeoutMs, authError);
        })
            .catch(err => {
            if (err.statusCode == null) {
                err.statusCode = 4003;
            }
            this.onError(err);
            this.disconnect(err.statusCode, err.toString());
        });
    }
    onPingPong() {
        this.send('');
        this.resetPingTimeout(this.isPingTimeoutDisabled ? false : this.pingTimeoutMs, 4000);
        this.socket.emit('ping', {});
    }
    get pendingReconnect() {
        return (this._pendingReconnectTimeout !== null);
    }
    get pingTimeoutMs() {
        return this._pingTimeoutMs;
    }
    set pingTimeoutMs(value) {
        this._pingTimeoutMs = value;
        this.resetPingTimeout(this.isPingTimeoutDisabled ? false : this.pingTimeoutMs, 4000);
    }
    resetReconnect() {
        this._pendingReconnectTimeout = null;
        this._connectAttempts = 0;
    }
    async send(data) {
        this.webSocket.send(data);
    }
    async setAuthorization(signedAuthToken, authToken) {
        const wasAuthenticated = !!this.signedAuthToken;
        const changed = await super.setAuthorization(signedAuthToken, authToken);
        if (changed) {
            this.triggerAuthenticationEvents(false, wasAuthenticated);
            // Even if saving the auth token failes we do NOT want to throw an exception.
            this.authEngine.saveToken(this.signedAuthToken)
                .catch(err => {
                this.onError(err);
            });
        }
        return changed;
    }
    get status() {
        if (this.pendingReconnect) {
            return 'connecting';
        }
        return super.status;
    }
    tryReconnect(initialDelay) {
        if (!this.autoReconnect) {
            return;
        }
        const exponent = this._connectAttempts++;
        const reconnectOptions = this.autoReconnect;
        let timeoutMs;
        if (initialDelay == null || exponent > 0) {
            const initialTimeout = Math.round(reconnectOptions.initialDelay + (reconnectOptions.randomness || 0) * Math.random());
            timeoutMs = Math.round(initialTimeout * Math.pow(reconnectOptions.multiplier, exponent));
        }
        else {
            timeoutMs = initialDelay;
        }
        if (timeoutMs > reconnectOptions.maxDelayMs) {
            timeoutMs = reconnectOptions.maxDelayMs;
        }
        this._pendingReconnectTimeout = timeoutMs;
        this.connect({ connectTimeoutMs: timeoutMs });
    }
    get uri() {
        return this._uri;
    }
    get webSocket() {
        return super.webSocket;
    }
    set webSocket(value) {
        if (this.webSocket) {
            if (this._connectTimeoutRef) {
                clearTimeout(this._connectTimeoutRef);
                this._connectTimeoutRef = null;
            }
        }
        super.webSocket = value;
        if (this.webSocket && this.webSocket.on) {
            // WebSockets will throw an error if they are closed before they are completely open.
            // We hook into these events to supress those errors and clean them up after a connection is established.
            function onOpenCloseError() {
                this.off('open', onOpenCloseError);
                this.off('close', onOpenCloseError);
                this.off('error', onOpenCloseError);
            }
            this.webSocket.on('open', onOpenCloseError);
            this.webSocket.on('close', onOpenCloseError);
            this.webSocket.on('error', onOpenCloseError);
        }
    }
    async transmit(serviceAndMethod, arg) {
        if (this.status === 'closed') {
            this.connect();
            await this.socket.listen('connect').once();
        }
        await super.transmit(serviceAndMethod, arg);
    }
    invoke(methodOptions, arg) {
        let abort;
        return [
            Promise.resolve()
                .then(() => {
                if (this.status === 'closed') {
                    this.connect();
                    return this.socket.listen('connect').once();
                }
            })
                .then(() => {
                const result = super.invoke(methodOptions, arg);
                abort = result[1];
                return result[0];
            }),
            abort
        ];
    }
}

function parseClientOptions(options) {
    if (typeof options === 'string' || 'pathname' in options) {
        options = { address: options };
    }
    return Object.assign({}, options);
}

class ClientSocket extends Socket {
    constructor(options) {
        options = parseClientOptions(options);
        options.handlers =
            Object.assign({
                "#kickOut": kickOutHandler,
                "#publish": publishHandler,
                "#setAuthToken": setAuthTokenHandler,
                "#removeAuthToken": removeAuthTokenHandler
            }, options.handlers);
        const clientTransport = new ClientTransport(options);
        super(clientTransport, options);
        this._clientTransport = clientTransport;
        this.channels = new ClientChannels(this._clientTransport, options);
        if (options.autoConnect !== false) {
            this.connect(options);
        }
    }
    async authenticate(signedAuthToken) {
        try {
            await this._clientTransport.invoke('#authenticate', signedAuthToken)[0];
            this._clientTransport.setAuthorization(signedAuthToken);
            // In order for the events to trigger we need to wait for the next tick.
            await wait(0);
        }
        catch (err) {
            if (err.name !== 'BadConnectionError' && err.name !== 'TimeoutError') {
                // In case of a bad/closed connection or a timeout, we maintain the last
                // known auth state since those errors don't mean that the token is invalid.
                await this._clientTransport.changeToUnauthenticatedState();
                // In order for the events to trigger we need to wait for the next tick.
                await wait(0);
            }
            throw hydrateError(err);
        }
    }
    get autoReconnect() {
        return this._clientTransport.autoReconnect;
    }
    set autoReconnect(value) {
        this._clientTransport.autoReconnect = value;
    }
    connect(options) {
        this._clientTransport.connect(options);
    }
    get connectTimeoutMs() {
        return this._clientTransport.connectTimeoutMs;
    }
    set connectTimeoutMs(timeoutMs) {
        this._clientTransport.connectTimeoutMs = timeoutMs;
    }
    async deauthenticate() {
        (async () => {
            let oldAuthToken;
            try {
                oldAuthToken = await this._clientTransport.authEngine.removeToken();
            }
            catch (err) {
                this._clientTransport.onError(err);
                return;
            }
            this.emit('removeAuthToken', { oldAuthToken });
        })();
        if (this.status !== 'closed') {
            await this._clientTransport.transmit('#removeAuthToken');
        }
        return await super.deauthenticate();
    }
    get isPingTimeoutDisabled() {
        return this._clientTransport.isPingTimeoutDisabled;
    }
    set isPingTimeoutDisabled(isDisabled) {
        this._clientTransport.isPingTimeoutDisabled = isDisabled;
    }
    get pingTimeoutMs() {
        return this._clientTransport.pingTimeoutMs;
    }
    set pingTimeoutMs(timeoutMs) {
        this._clientTransport.pingTimeoutMs = timeoutMs;
    }
    reconnect(code, reason) {
        this.disconnect(code, reason);
        this.connect();
    }
    get type() {
        return this._clientTransport.type;
    }
    get uri() {
        return this._clientTransport.uri;
    }
}

export { BatchingPlugin, ClientChannels, ClientSocket, ClientTransport, InOrderPlugin, LocalStorageAuthEngine, OfflinePlugin, RequestBatchingPlugin, ResponseBatchingPlugin, isAuthEngine, kickOutHandler, parseClientOptions, publishHandler, removeAuthTokenHandler, setAuthTokenHandler };
