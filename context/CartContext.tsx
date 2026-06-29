import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { InteractionManager } from 'react-native';
import { useUser } from './UserContext';
import { useHistoryEvents } from './HistoryContext';
import { BASE_CURRENCY, convertPrice, ensureExchangeRates, formatMoney } from '../utils/currency';
import { buildCheckoutTotals, SHOPIFY_CHECKOUT_CURRENCY } from '../utils/checkout-totals';
import { getCartStorageKey } from '../utils/customer-storage';
import {
  getCustomerOrders,
  getGuestSessionOrders,
  saveCustomerOrders,
  saveGuestSessionOrders,
  type CustomerOrder,
} from '../utils/customer-orders';
import { getCustomerProfile } from '../utils/customer-profile';
import {
  buildPaymentOrder,
  isDuplicatePaymentOrder,
  type PaymentOrderSaveInput,
} from '../utils/order-save';
import { syncCustomerOrdersWithShopify } from '../utils/shopify-orders-sync';
import { recordCartProduct, recordPurchasedProducts } from '../utils/recommendation-signals';
import { getPaymentCustomerEmail } from '../utils/customer';
import { PAYMENT_TESTING_MODE } from '../utils/payment-testing';
import { signalScratchInstantTrigger } from '../utils/scratch-prize-popup';

const CartContext = createContext<any>(null);

const LEGACY_CART_STORAGE_KEY = 'NOOD_CART';
const GUEST_PROFILE_ID_KEY = 'USER_GUEST_PROFILE_ID';
const BALANCE_KEY = 'NOOD_BALANCE';
const WALLET_HISTORY_KEY = 'NOOD_WALLET_HISTORY';
const LOCKED_REWARDS_KEY = 'NOOD_LOCKED_REWARDS';

type WalletEntry = {
  id: string;
  type: 'refund' | 'spend' | 'credit' | 'debit' | 'topup' | 'purchase';
  amount: number;
  currency: string;
  note: string;
  orderId?: string;
  provider?: string;
  transactionId?: string;
  status?: string;
  createdAt: string;
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

const makeProfileStorageKey = (baseKey: string, profileId: string) => `${baseKey}:${profileId}`;

const clearGuestWalletState = () => ({
  balance: 0,
  walletHistory: [] as WalletEntry[],
  orders: [] as CustomerOrder[],
  lockedRewards: [] as LockedReward[],
});

export const CartProvider = ({ children }: any) => {
  const { settings, isSignedIn, profileId, isReady: userReady } = useUser();
  const { addHistoryEvent } = useHistoryEvents();

  const cartStorageKey = useMemo(
    () => (userReady && profileId ? getCartStorageKey(profileId, '', isSignedIn) : ''),
    [isSignedIn, profileId, userReady]
  );

  const [cartItems, setCartItems] = useState<any[]>([]);
  const [balance, setBalance] = useState<number>(0);
  const [walletHistory, setWalletHistory] = useState<WalletEntry[]>([]);
  const [orders, setOrders] = useState<CustomerOrder[]>([]);
  const ordersRef = useRef<CustomerOrder[]>([]);
  const [ordersSyncing, setOrdersSyncing] = useState(false);
  const [lockedRewards, setLockedRewards] = useState<LockedReward[]>([]);
  const [loading, setLoading] = useState(true);
  const [ratesVersion, setRatesVersion] = useState(0);

  const addWalletEntry = useCallback((entry: WalletEntry) => {
    setWalletHistory((prev) => [entry, ...prev]);
  }, []);

  const syncLockedRewards = useCallback((ordersToUse: CustomerOrder[], rewardsToUse: LockedReward[]) => {
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

  useEffect(() => {
    ordersRef.current = orders;
  }, [orders]);

  const applyOrdersState = useCallback(
    (nextOrders: CustomerOrder[]) => {
      ordersRef.current = nextOrders;
      setOrders(nextOrders);
      setLockedRewards((prevRewards) => syncLockedRewards(nextOrders, prevRewards));
      return nextOrders;
    },
    [syncLockedRewards]
  );

  const syncOrdersAfterPayment = useCallback(
    async (baseOrders?: CustomerOrder[]) => {
      console.log('[SHOPIFY ORDER SYNC AFTER PAYMENT]');
      if (!profileId || (!isSignedIn && !PAYMENT_TESTING_MODE)) {
        return;
      }

      setOrdersSyncing(true);

      try {
        const profile = await getCustomerProfile();
        const customerEmail = getPaymentCustomerEmail(profile?.email);
        if (!customerEmail) {
          return;
        }

        const localOrders = baseOrders || ordersRef.current;
        const syncResult = await syncCustomerOrdersWithShopify({
          localOrders,
          email: customerEmail,
          shopifyCustomerId: profile?.shopifyCustomerId,
        });

        if (syncResult.orders.length) {
          applyOrdersState(syncResult.orders);
          if (isSignedIn) {
            await saveCustomerOrders(profileId, syncResult.orders, customerEmail, true);
          } else {
            await saveGuestSessionOrders(profileId, syncResult.orders);
          }
        }
      } catch (error) {
        console.log('[SHOPIFY ORDER SYNC AFTER PAYMENT] failed:', error);
      } finally {
        setOrdersSyncing(false);
      }
    },
    [applyOrdersState, isSignedIn, profileId]
  );

  const refreshOrdersFromShopify = useCallback(async (): Promise<CustomerOrder[]> => {
    if (!profileId || (!isSignedIn && !PAYMENT_TESTING_MODE)) {
      return ordersRef.current;
    }

    setOrdersSyncing(true);

    try {
      const profile = await getCustomerProfile();
      const customerEmail = getPaymentCustomerEmail(profile?.email);
      if (!customerEmail) {
        return ordersRef.current;
      }

      const localOrders = isSignedIn
        ? await getCustomerOrders(profileId, customerEmail, true)
        : await getGuestSessionOrders(profileId);
      const syncResult = await syncCustomerOrdersWithShopify({
        localOrders: localOrders.length ? localOrders : ordersRef.current,
        email: customerEmail,
        shopifyCustomerId: profile?.shopifyCustomerId,
      });

      if (syncResult.orders.length) {
        applyOrdersState(syncResult.orders);
        if (isSignedIn) {
          await saveCustomerOrders(profileId, syncResult.orders, customerEmail, true);
        } else {
          await saveGuestSessionOrders(profileId, syncResult.orders);
        }
        return syncResult.orders;
      }

      return ordersRef.current;
    } catch (error) {
      console.log('[NOOD orders] refresh from Shopify failed:', error);
      return ordersRef.current;
    } finally {
      setOrdersSyncing(false);
    }
  }, [applyOrdersState, isSignedIn, profileId]);

  const saveOrderAfterPayment = useCallback(
    async (input: PaymentOrderSaveInput): Promise<boolean> => {
      console.log('[ORDER SAVE START]', {
        shopifyOrderId: input.shopifyOrderId,
        shopifyOrderName: input.shopifyOrderName,
        checkoutOrderId: input.checkoutOrderId,
        transactionId: input.transactionId,
        total: input.total,
        itemCount: Array.isArray(input.items) ? input.items.length : 0,
      });

      try {
        const nextOrder = buildPaymentOrder(input);
        const previousOrders = ordersRef.current;
        const alreadySaved = previousOrders.some((entry) => isDuplicatePaymentOrder(entry, nextOrder));

        if (alreadySaved) {
          console.log('[ORDER SAVE SUCCESS]', {
            shopifyOrderName: nextOrder.shopifyOrderName,
            duplicate: true,
          });
          void syncOrdersAfterPayment(previousOrders);
          return true;
        }

        const nextOrders = [nextOrder, ...previousOrders];
        applyOrdersState(nextOrders);

        if (isSignedIn && profileId) {
          const profile = await getCustomerProfile();
          await saveCustomerOrders(profileId, nextOrders, profile?.email || '', true);
        } else if (profileId) {
          await saveGuestSessionOrders(profileId, nextOrders);
        }

        console.log('[ORDER SAVE SUCCESS]', {
          id: nextOrder.id,
          shopifyOrderName: nextOrder.shopifyOrderName,
          shopifyOrderId: nextOrder.shopifyOrderId,
        });

        void syncOrdersAfterPayment(nextOrders);
        return true;
      } catch (error) {
        console.log('[ORDER SAVE FAILED]', error);
        return false;
      }
    },
    [applyOrdersState, isSignedIn, profileId, syncOrdersAfterPayment]
  );

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
    let isMounted = true;

    const loadCart = async () => {
      if (!userReady || !profileId || !cartStorageKey) {
        return;
      }

      try {
        let savedCart = await AsyncStorage.getItem(cartStorageKey);

        if (!savedCart && isSignedIn) {
          const guestProfileId = String(
            (await AsyncStorage.getItem(GUEST_PROFILE_ID_KEY)) || ''
          ).trim();

          if (guestProfileId && guestProfileId !== profileId) {
            const guestCartKey = getCartStorageKey(guestProfileId, '', false);
            const guestCart = await AsyncStorage.getItem(guestCartKey);
            if (guestCart) {
              await AsyncStorage.setItem(cartStorageKey, guestCart);
              savedCart = guestCart;
            }
          }
        }

        if (!savedCart && !isSignedIn) {
          const legacyCart = await AsyncStorage.getItem(LEGACY_CART_STORAGE_KEY);
          if (legacyCart) {
            await AsyncStorage.setItem(cartStorageKey, legacyCart);
            await AsyncStorage.removeItem(LEGACY_CART_STORAGE_KEY);
            savedCart = legacyCart;
          }
        }

        if (!isMounted) {
          return;
        }

        setCartItems(savedCart ? JSON.parse(savedCart) : []);
      } catch (error) {
        console.log('load cart error', error);
        if (isMounted) {
          setCartItems([]);
        }
      }
    };

    void loadCart();

    return () => {
      isMounted = false;
    };
  }, [cartStorageKey, isSignedIn, profileId, userReady]);

  useEffect(() => {
    const loadData = async () => {
      try {
        if (!userReady) {
          return;
        }

        if (!isSignedIn || !profileId) {
          const guestState = clearGuestWalletState();
          const guestOrders = profileId ? await getGuestSessionOrders(profileId) : [];
          setBalance(guestState.balance);
          setWalletHistory(guestState.walletHistory);
          applyOrdersState(guestOrders);
          setLockedRewards(guestState.lockedRewards);
          return;
        }

        const balanceKey = makeProfileStorageKey(BALANCE_KEY, profileId);
        const walletHistoryKey = makeProfileStorageKey(WALLET_HISTORY_KEY, profileId);
        const lockedRewardsKey = makeProfileStorageKey(LOCKED_REWARDS_KEY, profileId);
        const customerProfile = await getCustomerProfile();
        const customerEmail = getPaymentCustomerEmail(customerProfile?.email);

        let [savedBalance, savedWalletHistory, savedLockedRewards, loadedOrders] = await Promise.all([
          AsyncStorage.getItem(balanceKey),
          AsyncStorage.getItem(walletHistoryKey),
          AsyncStorage.getItem(lockedRewardsKey),
          isSignedIn
            ? getCustomerOrders(profileId, customerEmail, true)
            : getGuestSessionOrders(profileId),
        ]);

        if (savedBalance === null && savedWalletHistory === null) {
          const [legacyBalance, legacyWalletHistory, legacyLockedRewards] = await Promise.all([
            AsyncStorage.getItem(BALANCE_KEY),
            AsyncStorage.getItem(WALLET_HISTORY_KEY),
            AsyncStorage.getItem(LOCKED_REWARDS_KEY),
          ]);

          if (
            legacyBalance !== null ||
            legacyWalletHistory !== null ||
            legacyLockedRewards !== null
          ) {
            savedBalance = legacyBalance;
            savedWalletHistory = legacyWalletHistory;
            savedLockedRewards = legacyLockedRewards;

            await Promise.all([
              AsyncStorage.setItem(balanceKey, legacyBalance || '0'),
              legacyWalletHistory
                ? AsyncStorage.setItem(walletHistoryKey, legacyWalletHistory)
                : Promise.resolve(),
              legacyLockedRewards
                ? AsyncStorage.setItem(lockedRewardsKey, legacyLockedRewards)
                : Promise.resolve(),
              AsyncStorage.multiRemove([BALANCE_KEY, WALLET_HISTORY_KEY, LOCKED_REWARDS_KEY]),
            ]);
          }
        }

        setBalance(savedBalance ? Number(savedBalance) : 0);
        setWalletHistory(savedWalletHistory ? JSON.parse(savedWalletHistory) : []);

        const parsedLockedRewards = savedLockedRewards ? JSON.parse(savedLockedRewards) : [];
        applyOrdersState(loadedOrders);
        setLockedRewards(syncLockedRewards(loadedOrders, parsedLockedRewards));

        if (customerEmail) {
          InteractionManager.runAfterInteractions(() => {
            void (async () => {
              const syncResult = await syncCustomerOrdersWithShopify({
                localOrders: loadedOrders,
                email: customerEmail,
                shopifyCustomerId: customerProfile?.shopifyCustomerId,
              });

              if (syncResult.orders.length) {
                applyOrdersState(syncResult.orders);
                if (isSignedIn) {
                  await saveCustomerOrders(profileId, syncResult.orders, customerEmail, true);
                } else {
                  await saveGuestSessionOrders(profileId, syncResult.orders);
                }
              }
            })();
          });
        }
      } catch (e) {
        console.log('load context error', e);
      } finally {
        setLoading(false);
      }
    };

    void loadData();
  }, [applyOrdersState, isSignedIn, profileId, syncLockedRewards, userReady]);

  useEffect(() => {
    if (!loading && cartStorageKey) {
      AsyncStorage.setItem(cartStorageKey, JSON.stringify(cartItems));
    }
  }, [cartItems, cartStorageKey, loading]);

  useEffect(() => {
    if (!loading && userReady && isSignedIn && profileId) {
      AsyncStorage.setItem(makeProfileStorageKey(BALANCE_KEY, profileId), String(balance));
    }
  }, [balance, isSignedIn, loading, profileId, userReady]);

  useEffect(() => {
    if (!loading && userReady && isSignedIn && profileId) {
      AsyncStorage.setItem(
        makeProfileStorageKey(WALLET_HISTORY_KEY, profileId),
        JSON.stringify(walletHistory)
      );
    }
  }, [isSignedIn, loading, profileId, userReady, walletHistory]);

  useEffect(() => {
    if (!loading && userReady && isSignedIn && profileId) {
      void getCustomerProfile().then((profile) => {
        void saveCustomerOrders(profileId, orders, profile?.email || '', isSignedIn);
      });
    }
  }, [isSignedIn, loading, orders, profileId, userReady]);

  useEffect(() => {
    if (!loading && userReady && isSignedIn && profileId) {
      AsyncStorage.setItem(
        makeProfileStorageKey(LOCKED_REWARDS_KEY, profileId),
        JSON.stringify(lockedRewards)
      );
    }
  }, [isSignedIn, loading, lockedRewards, profileId, userReady]);

  const addWalletFunds = (
    amount: number,
    note = 'Wallet top-up',
    metadata: Partial<WalletEntry> = {}
  ) => {
    if (!isSignedIn || !amount || amount <= 0) return;

    setBalance((prev) => prev + amount);

    addWalletEntry({
      id: metadata.id || Date.now().toString(),
      type: metadata.type || 'credit',
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

  const spendWalletFunds = (
    amount: number,
    note = 'Wallet payment',
    metadata: Partial<WalletEntry> = {}
  ) => {
    if (!isSignedIn || !amount || amount <= 0) return false;
    if (balance < amount) return false;

    setBalance((prev) => prev - amount);

    addWalletEntry({
      id: metadata.id || Date.now().toString(),
      type: metadata.type || 'debit',
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
      title: 'Wallet payment',
      description: note,
      amount,
      currency: BASE_CURRENCY,
      status: 'paid',
    });

    return true;
  };

  const refundToBalance = (amount: number, orderId?: string, note?: string) => {
    if (!isSignedIn || !amount || amount <= 0) return;

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

  const addOrder = (order: Omit<CustomerOrder, 'currency'> & { currency?: string }) => {
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
      void recordPurchasedProducts(
        { profileId: profileId || 'guest', isSignedIn },
        (nextOrder.items || [])
          .map((orderItem: any) => ({
            handle: String(orderItem?.handle || ''),
            id: String(orderItem?.id || orderItem?.variantId || ''),
            title: String(orderItem?.title || ''),
            tags: Array.isArray(orderItem?.tags) ? orderItem.tags.map(String) : [],
            productType: String(orderItem?.productType || ''),
            collectionHandles: Array.isArray(orderItem?.collectionHandles)
              ? orderItem.collectionHandles.map(String)
              : [],
            vendor: String(orderItem?.brand || orderItem?.vendor || ''),
          }))
          .filter((orderItem) => orderItem.handle)
      );
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

    void recordCartProduct(
      { profileId: profileId || 'guest', isSignedIn },
      {
        handle: String(item?.handle || ''),
        id: String(item?.id || variantId),
        title: String(item?.title || ''),
        tags: Array.isArray(item?.tags) ? item.tags.map(String) : [],
        productType: String(item?.productType || ''),
        collectionHandles: Array.isArray(item?.collectionHandles)
          ? item.collectionHandles.map(String)
          : item?.collectionHandle
            ? [String(item.collectionHandle)]
            : [],
        vendor: String(item?.brand || item?.vendor || ''),
      }
    );

    signalScratchInstantTrigger();
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

  const checkoutTotals = useMemo(() => {
    if (ratesVersion < 0) {
      return buildCheckoutTotals([], convertPrice, SHOPIFY_CHECKOUT_CURRENCY);
    }

    return buildCheckoutTotals(cartItems, convertPrice, SHOPIFY_CHECKOUT_CURRENCY);
  }, [cartItems, convertPrice, ratesVersion]);

  const cartSubtotalRaw = checkoutTotals.total;

  const syncWalletBalanceFromBackend = useCallback(
    (balanceTtd: number) => {
      if (!isSignedIn) return;

      const normalizedBalance = Number(balanceTtd || 0);
      const balanceInBase = convertPrice(normalizedBalance, SHOPIFY_CHECKOUT_CURRENCY, BASE_CURRENCY);
      setBalance(balanceInBase);
    },
    [convertPrice, isSignedIn]
  );

  const cartSubtotal = useMemo(() => {
    return formatMoney(cartSubtotalRaw, selectedCurrency);
  }, [cartSubtotalRaw, selectedCurrency]);

  const visibleBalance = isSignedIn ? balance : 0;
  const visibleWalletHistory = isSignedIn ? walletHistory : [];
  const visibleOrders = orders;

  const balanceConverted = useMemo(() => {
    if (ratesVersion < 0 || !isSignedIn) return 0;

    return convertPrice(visibleBalance, BASE_CURRENCY, selectedCurrency);
  }, [isSignedIn, ratesVersion, selectedCurrency, visibleBalance]);

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
        checkoutTotals,
        syncWalletBalanceFromBackend,
        addToCart,
        removeFromCart,
        updateQuantity,
        clearCart,

        balance: visibleBalance,
        balanceConverted,
        balanceFormatted,
        lockedRewards: isSignedIn ? lockedRewards : [],
        lockedBalance: isSignedIn ? lockedBalance : 0,
        lockedBalanceConverted: isSignedIn ? lockedBalanceConverted : 0,
        lockedBalanceFormatted: isSignedIn ? lockedBalanceFormatted : formatMoney(0, selectedCurrency),
        walletHistory: visibleWalletHistory,
        isSignedInWallet: isSignedIn,
        addWalletFunds,
        addLockedReward,
        refreshLockedRewards,
        spendWalletFunds,
        refundToBalance,

        orders: visibleOrders,
        ordersSyncing,
        refreshOrdersFromShopify,
        saveOrderAfterPayment,
        syncOrdersAfterPayment,
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
