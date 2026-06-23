import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useUser } from './UserContext';
import { useHistoryEvents } from './HistoryContext';
import { BASE_CURRENCY, convertPrice, ensureExchangeRates, formatMoney } from '../utils/currency';

const CartContext = createContext<any>(null);

const STORAGE_KEY = 'NOOD_CART';
const BALANCE_KEY = 'NOOD_BALANCE';
const WALLET_HISTORY_KEY = 'NOOD_WALLET_HISTORY';
const ORDERS_KEY = 'NOOD_ORDERS';
const LOCKED_REWARDS_KEY = 'NOOD_LOCKED_REWARDS';

type WalletEntry = {
  id: string;
  type: 'refund' | 'spend' | 'credit' | 'debit';
  amount: number;
  currency: string;
  note: string;
  orderId?: string;
  provider?: string;
  transactionId?: string;
  status?: string;
  createdAt: string;
};

type Order = {
  id: string;
  date: string;
  total: number;
  currency: string;
  status: string;
  paymentMethod: string;
  shopifyOrderId?: string;
  shopifyOrderName?: string;
  paymentTransactionId?: string;
  refunded?: boolean;
  shippingAddress?: any;
  items?: any[];
};

type LockedReward = {
  id: string;
  amount: number;
  currency: string;
  note: string;
  unlockRequirement: number;
  totalSpentTowardsUnlock: number;
  createdAt: string;
  expiresAt: string;
  unlockedAt?: string;
  status: 'locked' | 'unlocked' | 'expired';
};

export const CartProvider = ({ children }: any) => {
  const { settings } = useUser();
  const { addHistoryEvent } = useHistoryEvents();

  const [cartItems, setCartItems] = useState<any[]>([]);
  const [balance, setBalance] = useState<number>(0);
  const [walletHistory, setWalletHistory] = useState<WalletEntry[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [lockedRewards, setLockedRewards] = useState<LockedReward[]>([]);
  const [loading, setLoading] = useState(true);
  const [ratesVersion, setRatesVersion] = useState(0);

  const addWalletEntry = useCallback((entry: WalletEntry) => {
    setWalletHistory((prev) => [entry, ...prev]);
  }, []);

  const syncLockedRewards = useCallback((ordersToUse: Order[], rewardsToUse: LockedReward[]) => {
    const now = Date.now();
    const unlockedEntries: LockedReward[] = [];

    const nextRewards = rewardsToUse.map((reward) => {
      if (reward.status === 'unlocked' || reward.status === 'expired') {
        return reward;
      }

      if (new Date(reward.expiresAt).getTime() <= now) {
        return { ...reward, status: 'expired' as const };
      }

      const qualifyingSpend = ordersToUse.reduce((sum, order) => {
        const total = Number(order?.total || 0);
        const orderTime = new Date(order?.date || 0).getTime();
        const rewardStart = new Date(reward.createdAt).getTime();

        if (total <= 10 || orderTime < rewardStart) {
          return sum;
        }

        return sum + total;
      }, 0);

      const updatedReward = {
        ...reward,
        totalSpentTowardsUnlock: Math.min(qualifyingSpend, reward.unlockRequirement),
      };

      if (updatedReward.totalSpentTowardsUnlock >= updatedReward.unlockRequirement) {
        const unlockedReward = {
          ...updatedReward,
          status: 'unlocked' as const,
          unlockedAt: new Date().toISOString(),
        };
        unlockedEntries.push(unlockedReward);
        return unlockedReward;
      }

      return updatedReward;
    });

    if (unlockedEntries.length) {
      const unlockedTotal = unlockedEntries.reduce((sum, reward) => sum + Number(reward.amount || 0), 0);
      setBalance((prev) => prev + unlockedTotal);
      unlockedEntries.forEach((reward) => {
        addWalletEntry({
          id: `${reward.id}-unlock`,
          type: 'credit',
          amount: reward.amount,
          currency: BASE_CURRENCY,
          note: `Unlocked reward: ${reward.note}`,
          createdAt: reward.unlockedAt || new Date().toISOString(),
        });
        void addHistoryEvent({
          type: 'reward',
          title: 'Reward unlocked',
          description: `${reward.note} moved to wallet after qualifying spend.`,
          amount: reward.amount,
          currency: BASE_CURRENCY,
          status: 'unlocked',
          relatedId: reward.id,
        });
      });
    }

    nextRewards.forEach((reward) => {
      const original = rewardsToUse.find((item) => item.id === reward.id);
      if (original?.status === 'locked' && reward.status === 'expired') {
        void addHistoryEvent({
          type: 'reward',
          title: 'Reward expired',
          description: `${reward.note} expired before the spend goal was reached.`,
          amount: reward.amount,
          currency: BASE_CURRENCY,
          status: 'expired',
          relatedId: reward.id,
        });
      }
    });

    return nextRewards;
  }, [addHistoryEvent, addWalletEntry]);

  const refreshLockedRewards = useCallback(() => {
    setLockedRewards((prevRewards) => syncLockedRewards(orders, prevRewards));
  }, [orders, syncLockedRewards]);

  const selectedCurrency = settings?.currency || BASE_CURRENCY;

  useEffect(() => {
    let isMounted = true;

    ensureExchangeRates()
      .then(() => {
        if (isMounted) {
          setRatesVersion((version) => version + 1);
        }
      })
      .catch((error) => {
        console.log('exchange rate load error', error);
      });

    return () => {
      isMounted = false;
    };
  }, [selectedCurrency]);

  useEffect(() => {
    const loadData = async () => {
      try {
        const [savedCart, savedBalance, savedWalletHistory, savedOrders, savedLockedRewards] =
          await Promise.all([
            AsyncStorage.getItem(STORAGE_KEY),
            AsyncStorage.getItem(BALANCE_KEY),
            AsyncStorage.getItem(WALLET_HISTORY_KEY),
            AsyncStorage.getItem(ORDERS_KEY),
            AsyncStorage.getItem(LOCKED_REWARDS_KEY),
          ]);

        if (savedCart) setCartItems(JSON.parse(savedCart));
        if (savedBalance) setBalance(Number(savedBalance));
        if (savedWalletHistory) setWalletHistory(JSON.parse(savedWalletHistory));
        const parsedOrders = savedOrders ? JSON.parse(savedOrders) : [];
        const parsedLockedRewards = savedLockedRewards ? JSON.parse(savedLockedRewards) : [];
        setOrders(parsedOrders);
        setLockedRewards(syncLockedRewards(parsedOrders, parsedLockedRewards));
      } catch (e) {
        console.log('load context error', e);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [syncLockedRewards]);

  useEffect(() => {
    if (!loading) {
      AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cartItems));
    }
  }, [cartItems, loading]);

  useEffect(() => {
    if (!loading) {
      AsyncStorage.setItem(BALANCE_KEY, String(balance));
    }
  }, [balance, loading]);

  useEffect(() => {
    if (!loading) {
      AsyncStorage.setItem(WALLET_HISTORY_KEY, JSON.stringify(walletHistory));
    }
  }, [walletHistory, loading]);

  useEffect(() => {
    if (!loading) {
      AsyncStorage.setItem(ORDERS_KEY, JSON.stringify(orders));
    }
  }, [orders, loading]);

  useEffect(() => {
    if (!loading) {
      AsyncStorage.setItem(LOCKED_REWARDS_KEY, JSON.stringify(lockedRewards));
    }
  }, [lockedRewards, loading]);

  const addWalletFunds = (
    amount: number,
    note = 'Wallet top up',
    metadata: Partial<WalletEntry> = {}
  ) => {
    if (!amount || amount <= 0) return;

    setBalance((prev) => prev + amount);

    addWalletEntry({
      id: metadata.id || Date.now().toString(),
      type: 'credit',
      amount,
      currency: metadata.currency || BASE_CURRENCY,
      note,
      orderId: metadata.orderId,
      provider: metadata.provider,
      transactionId: metadata.transactionId,
      status: metadata.status || 'completed',
      createdAt: metadata.createdAt || new Date().toISOString(),
    });
    void addHistoryEvent({
      type: 'wallet',
      title: 'Wallet credit',
      description: note,
      amount,
      currency: metadata.currency || BASE_CURRENCY,
      status: metadata.status || 'completed',
      relatedId: metadata.transactionId || metadata.orderId,
    });
  };

  const spendWalletFunds = (amount: number, note = 'Wallet payment') => {
    if (!amount || amount <= 0) return false;
    if (balance < amount) return false;

    setBalance((prev) => prev - amount);

    addWalletEntry({
      id: Date.now().toString(),
      type: 'spend',
      amount,
      currency: BASE_CURRENCY,
      note,
      createdAt: new Date().toISOString(),
    });
    void addHistoryEvent({
      type: 'wallet',
      title: 'Wallet payment',
      description: note,
      amount,
      currency: BASE_CURRENCY,
      status: 'paid',
    });

    return true;
  };

  const refundToBalance = (amount: number, orderId?: string, note?: string) => {
    if (!amount || amount <= 0) return;

    const alreadyRefunded = orders.find((o) => o.id === orderId && o.refunded);
    if (alreadyRefunded) return;

    setBalance((prev) => prev + amount);

    addWalletEntry({
      id: Date.now().toString(),
      type: 'refund',
      amount,
      currency: BASE_CURRENCY,
      note: note || `Refund for order #${orderId}`,
      orderId,
      createdAt: new Date().toISOString(),
    });
    void addHistoryEvent({
      type: 'wallet',
      title: 'Refund to wallet',
      description: note || `Refund for order #${orderId}`,
      amount,
      currency: BASE_CURRENCY,
      status: 'refunded',
      relatedId: orderId,
    });

    setOrders((prev) =>
      prev.map((o) =>
        o.id === orderId
          ? {
              ...o,
              status: 'Refunded',
              refunded: true,
              paymentMethod: 'NOOD Balance',
            }
          : o
      )
    );
  };

  const addOrder = (order: Omit<Order, 'currency'> & { currency?: string }) => {
    setOrders((prev) => {
      const nextOrder = {
        ...order,
        currency: order.currency || BASE_CURRENCY,
      };
      const nextOrders = [
        nextOrder,
        ...prev,
      ];

      setLockedRewards((prevRewards) => syncLockedRewards(nextOrders, prevRewards));
      void addHistoryEvent({
        type: 'order',
        title: `Order #${nextOrder.id}`,
        description: `${nextOrder.status || 'Processing'} via ${nextOrder.paymentMethod || 'Wallet'}`,
        amount: Number(nextOrder.total || 0),
        currency: nextOrder.currency,
        status: nextOrder.status,
        relatedId: String(nextOrder.id),
        date: nextOrder.date,
        metadata: {
          paymentMethod: nextOrder.paymentMethod,
          shopifyOrderId: nextOrder.shopifyOrderId || null,
          shopifyOrderName: nextOrder.shopifyOrderName || null,
          paymentTransactionId: nextOrder.paymentTransactionId || null,
          items: nextOrder.items || [],
          shippingAddress: nextOrder.shippingAddress || null,
        },
      });
      return nextOrders;
    });
  };

  const markOrderRefunded = (orderId: string, method: string) => {
    setOrders((prev) =>
      prev.map((o) =>
        o.id === orderId
          ? {
              ...o,
              status: 'Refunded',
              refunded: true,
              paymentMethod: method,
            }
          : o
      )
    );
  };

  const addToCart = (item: any) => {
    const variantId = String(item?.variantId || '').trim();

    if (!variantId) {
      console.log('[NOOD cart] blocked addToCart without Shopify variantId', item);
      return false;
    }

    setCartItems((prev) => {
      const existing = prev.find(
        (i) =>
          String(i.variantId || i.id || '') === variantId &&
          String(i.size || '') === String(item.size || '') &&
          String(i.color || '') === String(item.color || '')
      );

      if (existing) {
        return prev.map((i) =>
          String(i.variantId || i.id || '') === variantId &&
          String(i.size || '') === String(item.size || '') &&
          String(i.color || '') === String(item.color || '')
            ? { ...i, quantity: (i.quantity || 1) + 1 }
            : i
        );
      }

      return [
        ...prev,
        {
          ...item,
          id: variantId,
          variantId,
          quantity: 1,
          baseCurrency: item.baseCurrency || BASE_CURRENCY,
        },
      ];
    });

    return true;
  };

  const removeFromCart = (id: string, size?: string, color?: string) => {
    setCartItems((prev) =>
      prev.filter(
        (i) =>
          !(
            i.id === id &&
            String(i.size || '') === String(size || '') &&
            String(i.color || '') === String(color || '')
          )
      )
    );
  };

  const updateQuantity = (id: string, qty: number, size?: string, color?: string) => {
    if (qty <= 0) {
      removeFromCart(id, size, color);
      return;
    }

    setCartItems((prev) =>
      prev.map((i) =>
        i.id === id &&
        String(i.size || '') === String(size || '') &&
        String(i.color || '') === String(color || '')
          ? { ...i, quantity: qty }
          : i
      )
    );
  };

  const clearCart = () => setCartItems([]);

  const cartCount = cartItems.reduce((sum, i) => sum + Number(i.quantity || 0), 0);

  const cartSubtotalRaw = useMemo(() => {
    if (ratesVersion < 0) return 0;

    return cartItems.reduce((sum, i) => {
      const itemPrice = Number(i.price || 0);
      const itemQuantity = Number(i.quantity || 0);
      const itemCurrency = i.baseCurrency || BASE_CURRENCY;

      const convertedPrice = convertPrice(itemPrice, itemCurrency, selectedCurrency);
      return sum + convertedPrice * itemQuantity;
    }, 0);
  }, [cartItems, selectedCurrency, ratesVersion]);

  const cartSubtotal = useMemo(() => {
    return formatMoney(cartSubtotalRaw, selectedCurrency);
  }, [cartSubtotalRaw, selectedCurrency]);

  const balanceConverted = useMemo(() => {
    if (ratesVersion < 0) return 0;

    return convertPrice(balance, BASE_CURRENCY, selectedCurrency);
  }, [balance, selectedCurrency, ratesVersion]);

  const balanceFormatted = useMemo(() => {
    return formatMoney(balanceConverted, selectedCurrency);
  }, [balanceConverted, selectedCurrency]);

  const lockedBalance = useMemo(() => {
    return lockedRewards
      .filter((reward) => reward.status === 'locked')
      .reduce((sum, reward) => sum + Number(reward.amount || 0), 0);
  }, [lockedRewards]);

  const lockedBalanceConverted = useMemo(() => {
    if (ratesVersion < 0) return 0;

    return convertPrice(lockedBalance, BASE_CURRENCY, selectedCurrency);
  }, [lockedBalance, selectedCurrency, ratesVersion]);

  const lockedBalanceFormatted = useMemo(() => {
    return formatMoney(lockedBalanceConverted, selectedCurrency);
  }, [lockedBalanceConverted, selectedCurrency]);

  const addLockedReward = (
    amount: number,
    unlockRequirement: number,
    note = 'Locked reward bonus',
    expiresHours = 48
  ) => {
    if (!amount || amount <= 0 || !unlockRequirement || unlockRequirement <= 0) return;

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + expiresHours * 60 * 60 * 1000);

    const reward = {
        id: Date.now().toString(),
        amount,
        currency: BASE_CURRENCY,
        note,
        unlockRequirement,
        totalSpentTowardsUnlock: 0,
        createdAt: createdAt.toISOString(),
        expiresAt: expiresAt.toISOString(),
        status: 'locked',
      } as LockedReward;

    setLockedRewards((prev) => [reward, ...prev]);
    void addHistoryEvent({
      type: 'reward',
      title: 'Locked reward won',
      description: `${note}. Spend ${formatMoney(unlockRequirement, BASE_CURRENCY)} to unlock.`,
      amount,
      currency: BASE_CURRENCY,
      status: 'locked',
      relatedId: reward.id,
      date: reward.createdAt,
    });
  };

  return (
    <CartContext.Provider
      value={{
        cartItems,
        cartCount,
        cartSubtotal,
        cartSubtotalRaw,
        addToCart,
        removeFromCart,
        updateQuantity,
        clearCart,

        balance,
        balanceConverted,
        balanceFormatted,
        lockedRewards,
        lockedBalance,
        lockedBalanceConverted,
        lockedBalanceFormatted,
        walletHistory,
        addWalletFunds,
        addLockedReward,
        refreshLockedRewards,
        spendWalletFunds,
        refundToBalance,

        orders,
        addOrder,
        markOrderRefunded,

        selectedCurrency,
        convertPrice,
        formatMoney,
      }}
    >
      {children}
    </CartContext.Provider>
  );
};

export const useCart = () => useContext(CartContext);
