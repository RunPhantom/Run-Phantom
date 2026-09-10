import { useEffect, useRef, useState } from "react";

type Listener<T = unknown> = (data: T) => void;
type ReplayableMessage = object & { type?: unknown };

interface RunPhantomEnvelope {
  event?: string;
  data?: unknown;
}

interface Broker {
  ws: WebSocket | null;
  connected: boolean;
  listeners: Map<string, Set<Listener>>;
  messageListeners: Set<Listener>;
  connectionListeners: Set<(connected: boolean) => void>;
  replayOnConnect: Map<string, object>;
  subscribe<T>(event: string, fn: Listener<T>): () => void;
  subscribeMessage<T>(fn: Listener<T>): () => void;
  send(msg: object): void;
}

let singleton: Broker | null = null;

function isRunPhantomEnvelope(value: unknown): value is RunPhantomEnvelope {
  return !!value && typeof value === "object";
}

function getBroker(): Broker {
  if (singleton) return singleton;

  const listeners = new Map<string, Set<Listener>>();
  const messageListeners = new Set<Listener>();
  const connectionListeners = new Set<(connected: boolean) => void>();
  const replayOnConnect = new Map<string, object>();

  const broker: Broker = {
    ws: null,
    connected: false,
    listeners,
    messageListeners,
    connectionListeners,
    replayOnConnect,
    subscribe<T>(event: string, fn: Listener<T>) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      const listener: Listener = (data) => fn(data as T);
      listeners.get(event)?.add(listener);
      return () => listeners.get(event)?.delete(listener);
    },
    subscribeMessage<T>(fn: Listener<T>) {
      const listener: Listener = (data) => fn(data as T);
      messageListeners.add(listener);
      return () => messageListeners.delete(listener);
    },
    send(msg) {
      const type = (msg as ReplayableMessage).type;
      if (typeof type === "string") replayOnConnect.set(type, msg);
      const ws = broker.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify(msg));
        } catch {}
      }
    },
  };

  function setConnected(connected: boolean) {
    broker.connected = connected;
    for (const listener of connectionListeners) listener(connected);
  }

  function connect() {
    const url = `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;
    const ws = new WebSocket(url);
    broker.ws = ws;

    ws.onopen = () => {
      setConnected(true);
      for (const message of replayOnConnect.values()) {
        try {
          ws.send(JSON.stringify(message));
        } catch {}
      }
    };

    ws.onclose = () => {
      setConnected(false);
      broker.ws = null;
      window.setTimeout(connect, 2000);
    };

    ws.onerror = () => setConnected(false);

    ws.onmessage = (event) => {
      try {
        const payload: unknown = JSON.parse(event.data);
        for (const listener of messageListeners) listener(payload);
        if (!isRunPhantomEnvelope(payload) || typeof payload.event !== "string") return;
        const handlers = listeners.get(payload.event);
        if (!handlers) return;
        for (const handler of handlers) handler(payload.data);
      } catch {}
    };
  }

  connect();
  singleton = broker;
  return broker;
}

export function useRunPhantomMessage<T = unknown>(handler: Listener<T>) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const broker = getBroker();
    return broker.subscribeMessage<T>((data) => handlerRef.current(data));
  }, []);
}

export function useRunPhantomEvent<T = unknown>(event: string, handler: Listener<T>) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const broker = getBroker();
    return broker.subscribe<T>(event, (data) => handlerRef.current(data));
  }, [event]);
}

export function useRunPhantomConnected(): boolean {
  const [connected, setConnected] = useState(() => getBroker().connected);

  useEffect(() => {
    const broker = getBroker();
    broker.connectionListeners.add(setConnected);
    setConnected(broker.connected);
    return () => {
      broker.connectionListeners.delete(setConnected);
    };
  }, []);

  return connected;
}

export function sendRunPhantomMessage(message: object): void {
  getBroker().send(message);
}
