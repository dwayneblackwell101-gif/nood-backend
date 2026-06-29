import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useUser } from '../context/UserContext';
import AccountGuestState from './AccountGuestState';
import NoodSpinner from './NoodSpinner';
import { SIGN_IN_REQUIRED } from '../utils/payment-testing';

export const ACCOUNT_SIGN_IN_GATE_DISABLED = !SIGN_IN_REQUIRED;

type RequireSignInProps = {
  feature: string;
  title?: string;
  subtitle?: string;
  icon?: React.ComponentProps<typeof AccountGuestState>['icon'];
  children: React.ReactNode;
};

export default function RequireSignIn({
  feature,
  title,
  subtitle,
  icon,
  children,
}: RequireSignInProps) {
  const { isReady, isSignedIn } = useUser();

  if (!isReady) {
    return (
      <View style={styles.loadingWrap}>
        <NoodSpinner size={48} />
      </View>
    );
  }

  if (ACCOUNT_SIGN_IN_GATE_DISABLED || isSignedIn) {
    return <>{children}</>;
  }

  return (
    <AccountGuestState
      title={title || 'Sign in required'}
      subtitle={
        subtitle ||
        `Sign in to access ${feature}. Your customer data stays private until you sign in.`
      }
      icon={icon}
    />
  );
}

const styles = StyleSheet.create({
  loadingWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#fff7f2',
    padding: 24,
  },
});