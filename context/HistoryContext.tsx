import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUser } from './UserContext';

const HISTORY_STORAGE_KEY = 'NOOD_HISTORY_EVENTS_V1';

export type HistoryEventType =
  | 'order'
  | 'wallet'
  | 'reward'
  | 'address'
  | 'wishlist'
  | 'checkout'
  | 'account';

export type HistoryEvent = {
  id: string;
  type: HistoryEventType;
  title: string;
  description: string;
  amount?: number;
  currency?: string;
  date: string;
  status?: string;
  relatedId?: string;
  metadata?: Record<string, any>;
};

type HistoryEventInput = Omit<HistoryEvent, 'id' | 'date'> & {
  id?: string;
  date?: string;
};

type HistoryContextValue = {
  historyEvents: HistoryEvent[];
  addHistoryEvent: (event: HistoryEventInput) => Promise<void>;
  clearHistoryEvents: () => Promise<void>;
};

const HistoryContext = createContext<HistoryContextValue | null>(null);

const makeStorageKey = (profileId: string) => `${HISTORY_STORAGE_KEY}:${profileId || 'guest'}`;

export function HistoryProvider({ children }: { children: React.ReactNode }) {
  const { profileId, isReady } = useUser();
  const [historyEvents, setHistoryEvents] = useState<HistoryEvent[]>([]);
  const storageKey = useMemo(() => makeStorageKey(profileId), [profileId]);

  useEffect(() => {
    let isMounted = true;

    const loadEvents = async () => {
      if (!isReady) return;

      try {
        const saved = await AsyncStorage.getItem(storageKey);
        const parsed = saved ? JSON.parse(saved) : [];
        if (isMounted) {
          setHistoryEvents(Array.isArray(parsed) ? parsed : []);
        }
      } catch (error) {
        console.log('History load error:', error);
        if (isMounted) setHistoryEvents([]);
      }
    };

    void loadEvents();

    return () => {
      isMounted = false;
    };
  }, [isReady, storageKey]);

  const persist = useCallback(
    async (nextEvents: HistoryEvent[]) => {
      setHistoryEvents(nextEvents);
      await AsyncStorage.setItem(storageKey, JSON.stringify(nextEvents.slice(0, 250)));
    },
    [storageKey]
  );

  const addHistoryEvent = useCallback(
    async (event: HistoryEventInput) => {
      const nextEvent: HistoryEvent = {
        ...event,
        id: event.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        date: event.date || new Date().toISOString(),
      };

      setHistoryEvents((prev) => {
        const duplicateKey = `${nextEvent.type}:${nextEvent.relatedId || nextEvent.id}:${nextEvent.status || ''}:${nextEvent.title}`;
        const existing = prev.some(
          (item) => `${item.type}:${item.relatedId || item.id}:${item.status || ''}:${item.title}` === duplicateKey
        );
        const nextEvents = existing ? prev : [nextEvent, ...prev].slice(0, 250);
        void AsyncStorage.setItem(storageKey, JSON.stringify(nextEvents));
        return nextEvents;
      });
    },
    [storageKey]
  );

  const clearHistoryEvents = useCallback(async () => {
    await persist([]);
  }, [persist]);

  const value = useMemo(
    () => ({
      historyEvents,
      addHistoryEvent,
      clearHistoryEvents,
    }),
    [addHistoryEvent, clearHistoryEvents, historyEvents]
  );

  return <HistoryContext.Provider value={value}>{children}</HistoryContext.Provider>;
}

export function useHistoryEvents() {
  const context = useContext(HistoryContext);

  if (!context) {
    throw new Error('useHistoryEvents must be used inside HistoryProvider');
  }

  return context;
}
