import React, { useEffect } from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import NoodSpinner from '../../components/NoodSpinner';

export default function SavedScreen() {
  const router = useRouter();

  useEffect(() => {
    router.replace('/wishlist' as any);
  }, [router]);

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: '#fff7f2',
      }}
    >
      <NoodSpinner size={40} />
    </View>
  );
}