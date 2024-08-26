import { MethodMap, ServiceMap, PublicMethodMap, PrivateMethodMap, SocketOptions, SocketTransport, SocketStatus, FunctionReturnType, InvokeServiceOptions, InvokeMethodOptions, Socket, RequestHandlerArgs, SocketMap, EmptySocketMap, Plugin, SendRequestPluginArgs, SendResponsePluginArgs, PluginArgs, MessageRawPluginArgs } from '@socket-mesh/core';
import ws from 'isomorphic-ws';
import { SignedAuthToken, AuthToken } from '@socket-mesh/auth';
import { ChannelMap, PublishOptions, ChannelOptions, ChannelsOptions, Channels, ChannelDetails } from '@socket-mesh/channels';
import { RawData } from 'ws';

interface ClientAuthEngine {
    saveToken(token: SignedAuthToken, options?: {
        [key: string]: any;
    }): Promise<SignedAuthToken>;
    removeToken(): Promise<SignedAuthToken>;
    loadToken(): Promise<SignedAuthToken | null>;
}
declare function isAuthEngine(auth: ClientAuthEngine | LocalStorageAuthEngineOptions): auth is ClientAuthEngine;
interface LocalStorageAuthEngineOptions {
    authTokenName?: string;
}
declare class LocalStorageAuthEngine implements ClientAuthEngine {
    private readonly _authTokenName;
    private readonly _internalStorage;
    readonly isLocalStorageEnabled: boolean;
    constructor({ authTokenName }?: LocalStorageAuthEngineOptions);
    private _checkLocalStorageEnabled;
    saveToken(token: string): Promise<SignedAuthToken>;
    removeToken(): Promise<SignedAuthToken>;
    loadToken(): Promise<SignedAuthToken>;
}

interface ClientMap {
    Channel: ChannelMap;
    Incoming: MethodMap;
    Service: ServiceMap;
    Outgoing: PublicMethodMap;
    PrivateOutgoing: PrivateMethodMap;
    State: object;
}
interface KickOutOptions {
    channel: string;
    message: string;
}
type ClientPrivateMap = {
    '#kickOut': (options: KickOutOptions) => void;
    '#setAuthToken': (token: SignedAuthToken) => void;
    '#removeAuthToken': () => void;
    '#publish': (options: PublishOptions) => void;
};

interface HandshakeOptions {
    authToken: SignedAuthToken;
}
type HandshakeStatus = HandshakeErrorStatus | HandshakeAuthenticatedStatus;
interface HandshakeErrorStatus {
    id: string;
    pingTimeoutMs: number;
    authError: Error;
}
interface HandshakeAuthenticatedStatus {
    id: string;
    pingTimeoutMs: number;
    authToken: SignedAuthToken;
}
interface SubscribeOptions extends ChannelOptions {
    channel: string;
}
type ServerPrivateMap = {
    '#authenticate': (authToken: string) => void;
    '#handshake': (options: HandshakeOptions) => HandshakeStatus;
    '#publish': (options: PublishOptions) => void;
    '#removeAuthToken': () => void;
    '#subscribe': (options: SubscribeOptions) => void;
    '#unsubscribe': (channelName: string) => void;
};

interface SocketMapFromClient<T extends ClientMap> {
    Incoming: T['Incoming'] & ClientPrivateMap;
    Service: T['Service'];
    Outgoing: T['Outgoing'];
    PrivateOutgoing: T['PrivateOutgoing'] & ServerPrivateMap;
    State: T['State'];
}
interface BasicSocketMapClient<TOutgoing extends PublicMethodMap = {}, TState extends object = {}> {
    Incoming: ClientPrivateMap;
    Service: {};
    Outgoing: TOutgoing;
    PrivateOutgoing: ServerPrivateMap;
    State: TState;
}

interface AutoReconnectOptions {
    initialDelay: number;
    randomness: number;
    multiplier: number;
    maxDelayMs: number;
}
interface ConnectOptions {
    address?: string | URL;
    connectTimeoutMs?: number;
    wsOptions?: ws.ClientOptions;
}
interface ClientSocketOptions<T extends ClientMap> extends SocketOptions<SocketMapFromClient<T>>, ConnectOptions {
    autoConnect?: boolean;
    authEngine?: ClientAuthEngine | LocalStorageAuthEngineOptions | null;
    autoReconnect?: Partial<AutoReconnectOptions> | boolean;
    autoSubscribeOnConnect?: boolean;
    channelPrefix?: string;
}
declare function parseClientOptions<T extends ClientMap>(options: ClientSocketOptions<T> | string | URL): ClientSocketOptions<T>;

declare class ClientTransport<T extends ClientMap> extends SocketTransport<SocketMapFromClient<T>> {
    readonly authEngine: ClientAuthEngine;
    private _uri;
    private _wsOptions;
    connectTimeoutMs: number;
    private _connectTimeoutRef;
    private _autoReconnect;
    private _connectAttempts;
    private _pendingReconnectTimeout;
    private _pingTimeoutMs;
    isPingTimeoutDisabled: boolean;
    constructor(options: ClientSocketOptions<T>);
    get autoReconnect(): AutoReconnectOptions | false;
    set autoReconnect(value: Partial<AutoReconnectOptions> | boolean);
    connect(options?: ConnectOptions): void;
    get connectAttempts(): number;
    disconnect(code?: number, reason?: string): void;
    private handshake;
    protected onClose(code: number, reason?: Buffer): void;
    protected onOpen(): void;
    protected onPingPong(): void;
    get pendingReconnect(): boolean;
    get pingTimeoutMs(): number;
    set pingTimeoutMs(value: number);
    private resetReconnect;
    send(data: Buffer | string): Promise<void>;
    setAuthorization(authToken: AuthToken): Promise<boolean>;
    setAuthorization(signedAuthToken: string, authToken?: AuthToken): Promise<boolean>;
    get status(): SocketStatus;
    private tryReconnect;
    type: 'client';
    get uri(): URL;
    protected get webSocket(): ws.WebSocket | null;
    protected set webSocket(value: ws.WebSocket | null);
    transmit<TMethod extends keyof SocketMapFromClient<T>['Outgoing']>(method: TMethod, arg?: Parameters<SocketMapFromClient<T>['Outgoing'][TMethod]>[0]): Promise<void>;
    transmit<TService extends keyof SocketMapFromClient<T>['Service'], TMethod extends keyof SocketMapFromClient<T>['Service'][TService]>(options: [TService, TMethod], arg?: Parameters<SocketMapFromClient<T>['Service'][TService][TMethod]>[0]): Promise<void>;
    transmit<TMethod extends keyof (SocketMapFromClient<T>['PrivateOutgoing'] & ServerPrivateMap)>(method: TMethod, arg?: Parameters<(SocketMapFromClient<T>['PrivateOutgoing'] & ServerPrivateMap)[TMethod]>[0]): Promise<void>;
    invoke<TMethod extends keyof SocketMapFromClient<T>['Outgoing']>(method: TMethod, arg?: Parameters<SocketMapFromClient<T>['Outgoing'][TMethod]>[0]): [Promise<FunctionReturnType<SocketMapFromClient<T>['Outgoing'][TMethod]>>, () => void];
    invoke<TService extends keyof SocketMapFromClient<T>['Service'], TMethod extends keyof SocketMapFromClient<T>['Service'][TService]>(options: [TService, TMethod, (number | false)?], arg?: Parameters<SocketMapFromClient<T>['Service'][TService][TMethod]>[0]): [Promise<FunctionReturnType<SocketMapFromClient<T>['Service'][TService][TMethod]>>, () => void];
    invoke<TService extends keyof SocketMapFromClient<T>['Service'], TMethod extends keyof SocketMapFromClient<T>['Service'][TService]>(options: InvokeServiceOptions<SocketMapFromClient<T>['Service'], TService, TMethod>, arg?: Parameters<SocketMapFromClient<T>['Service'][TService][TMethod]>[0]): [Promise<FunctionReturnType<SocketMapFromClient<T>['Service'][TService][TMethod]>>, () => void];
    invoke<TMethod extends keyof SocketMapFromClient<T>['Outgoing']>(options: InvokeMethodOptions<SocketMapFromClient<T>['Outgoing'], TMethod>, arg?: Parameters<SocketMapFromClient<T>['Outgoing'][TMethod]>[0]): [Promise<FunctionReturnType<SocketMapFromClient<T>['Outgoing'][TMethod]>>, () => void];
    invoke<TMethod extends keyof (SocketMapFromClient<T>['PrivateOutgoing'] & ServerPrivateMap)>(method: TMethod, arg: Parameters<(SocketMapFromClient<T>['PrivateOutgoing'] & ServerPrivateMap)[TMethod]>[0]): [Promise<FunctionReturnType<(SocketMapFromClient<T>['PrivateOutgoing'] & ServerPrivateMap)[TMethod]>>, () => void];
    invoke<TMethod extends keyof (SocketMapFromClient<T>['PrivateOutgoing'] & ServerPrivateMap)>(options: InvokeMethodOptions<(SocketMapFromClient<T>['PrivateOutgoing'] & ServerPrivateMap), TMethod>, arg?: Parameters<(SocketMapFromClient<T>['PrivateOutgoing'] & ServerPrivateMap)[TMethod]>[0]): [Promise<FunctionReturnType<(SocketMapFromClient<T>['PrivateOutgoing'] & ServerPrivateMap)[TMethod]>>, () => void];
}

interface ClientChannelsOptions extends ChannelsOptions {
    autoSubscribeOnConnect?: boolean;
}
declare class ClientChannels<T extends ClientMap> extends Channels<T['Channel']> {
    autoSubscribeOnConnect: boolean;
    protected readonly _transport: ClientTransport<T>;
    protected _preparingPendingSubscriptions: boolean;
    constructor(transport: ClientTransport<T>, options?: ClientChannelsOptions);
    private suspendSubscriptions;
    protected trySubscribe(channel: ChannelDetails): void;
    private processPendingSubscriptions;
    unsubscribe(channelName: keyof T['Channel'] & string): void;
    protected tryUnsubscribe(channel: ChannelDetails): void;
    private triggerChannelSubscribeFail;
    transmitPublish<U extends keyof T['Channel'] & string>(channelName: U, data: T['Channel'][U]): Promise<void>;
    invokePublish<U extends keyof T['Channel'] & string>(channelName: keyof T['Channel'] & string, data: T['Channel'][U]): Promise<void>;
}

declare class ClientSocket<T extends ClientMap> extends Socket<SocketMapFromClient<T>> {
    private readonly _clientTransport;
    readonly channels: ClientChannels<T>;
    constructor(address: string | URL);
    constructor(options: ClientSocketOptions<T>);
    authenticate(signedAuthToken: SignedAuthToken): Promise<void>;
    get autoReconnect(): AutoReconnectOptions | false;
    set autoReconnect(value: Partial<AutoReconnectOptions> | boolean);
    connect(options?: ConnectOptions): void;
    get connectTimeoutMs(): number;
    set connectTimeoutMs(timeoutMs: number);
    deauthenticate(): Promise<boolean>;
    get isPingTimeoutDisabled(): boolean;
    set isPingTimeoutDisabled(isDisabled: boolean);
    get pingTimeoutMs(): number;
    set pingTimeoutMs(timeoutMs: number);
    reconnect(code?: number, reason?: string): void;
    get type(): 'client';
    get uri(): URL;
}

declare function kickOutHandler({ socket, options }: RequestHandlerArgs<KickOutOptions, BasicSocketMapClient, ClientSocket<ClientMap>, ClientTransport<ClientMap>>): Promise<void>;

declare function publishHandler({ socket, options }: RequestHandlerArgs<PublishOptions, BasicSocketMapClient, ClientSocket<ClientMap>, ClientTransport<ClientMap>>): Promise<void>;

declare function removeAuthTokenHandler({ transport }: RequestHandlerArgs<void>): Promise<void>;

declare function setAuthTokenHandler({ transport, options }: RequestHandlerArgs<SignedAuthToken>): Promise<void>;

interface BatchingPluginOptions {
    batchOnHandshakeDuration?: number | false;
    batchInterval?: number;
}
declare abstract class BatchingPlugin<T extends SocketMap = EmptySocketMap> implements Plugin<T> {
    batchOnHandshakeDuration: number | boolean;
    batchInterval: number;
    private _batchingIntervalId;
    private _handshakeTimeoutId;
    private _isBatching;
    constructor(options?: BatchingPluginOptions);
    type: string;
    cancelBatching(): void;
    protected abstract flush(): void;
    get isBatching(): boolean;
    onReady(): void;
    onDisconnected(): void;
    startBatching(): void;
    private start;
    stopBatching(): void;
    private stop;
}
declare class RequestBatchingPlugin<T extends SocketMap = EmptySocketMap> extends BatchingPlugin<T> {
    private _requests;
    private _continue;
    constructor(options?: BatchingPluginOptions);
    cancelBatching(): void;
    protected flush(): void;
    sendRequest({ requests, cont }: SendRequestPluginArgs<T>): void;
    type: 'requestBatching';
}
declare class ResponseBatchingPlugin<T extends SocketMap = EmptySocketMap> extends BatchingPlugin<T> {
    private _responses;
    private _continue;
    constructor(options?: BatchingPluginOptions);
    protected flush(): void;
    sendResponse({ responses, cont }: SendResponsePluginArgs<T>): void;
    type: 'responseBatching';
}

declare class InOrderPlugin<T extends SocketMap = EmptySocketMap> implements Plugin<T> {
    type: 'inOrder';
    private readonly _inboundMessageStream;
    constructor();
    handleInboundMessageStream(): void;
    onEnd({ transport }: PluginArgs<T>): void;
    onMessageRaw(options: MessageRawPluginArgs<T>): Promise<string | RawData>;
}

declare class OfflinePlugin<T extends SocketMap = EmptySocketMap> implements Plugin<T> {
    private _isReady;
    private _requests;
    private _continue;
    constructor();
    type: "offline";
    sendRequest({ requests, cont }: SendRequestPluginArgs<T>): void;
    onReady(): void;
    onClose(): void;
    onDisconnected(): void;
    private flush;
}

export { type AutoReconnectOptions, type BasicSocketMapClient, BatchingPlugin, type BatchingPluginOptions, type ClientAuthEngine, ClientChannels, type ClientChannelsOptions, type ClientMap, type ClientPrivateMap, ClientSocket, type ClientSocketOptions, ClientTransport, type ConnectOptions, type HandshakeAuthenticatedStatus, type HandshakeErrorStatus, type HandshakeOptions, type HandshakeStatus, InOrderPlugin, type KickOutOptions, LocalStorageAuthEngine, type LocalStorageAuthEngineOptions, OfflinePlugin, RequestBatchingPlugin, ResponseBatchingPlugin, type ServerPrivateMap, type SocketMapFromClient, type SubscribeOptions, isAuthEngine, kickOutHandler, parseClientOptions, publishHandler, removeAuthTokenHandler, setAuthTokenHandler };
