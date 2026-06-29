let appBootstrapComplete = false;

export function isAppBootstrapComplete() {
  return appBootstrapComplete;
}

export function markAppBootstrapComplete() {
  appBootstrapComplete = true;
}