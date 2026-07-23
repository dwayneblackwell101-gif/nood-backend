const { getRewardsConfig } = require('./config');
const { createRewardsStore } = require('./store');
const { createRewardsService } = require('./service');
const { createRewardsRouter } = require('./routes');

function mountRewards({
  app,
  redis = null,
  redisWallet = null,
  lockService = null,
  requireCustomerAuth,
  namespace = 'nood',
  isProduction = false,
} = {}) {
  if (!app) {
    throw new Error('app is required to mount rewards routes');
  }
  if (!requireCustomerAuth) {
    throw new Error('requireCustomerAuth is required to mount rewards routes');
  }

  const config = getRewardsConfig();
  const store = createRewardsStore({ redis, namespace });
  const rewardsService = createRewardsService({
    store,
    redisWallet,
    lockService,
    config,
  });
  const router = createRewardsRouter({
    rewardsService,
    requireCustomerAuth,
    isProduction,
  });

  app.use('/api/rewards', router);
  console.log('[REWARDS] routes mounted at /api/rewards', {
    storeDriver: store.driver,
    walletReady: Boolean(redisWallet),
  });

  return {
    rewardsService,
    store,
    config,
  };
}

module.exports = {
  mountRewards,
  getRewardsConfig,
  createRewardsStore,
  createRewardsService,
  createRewardsRouter,
};
