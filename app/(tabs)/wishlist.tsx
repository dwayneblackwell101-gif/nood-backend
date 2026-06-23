import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';

export default function Screen() {
  return (
    <View style={styles.container}>
      <Image
        source={require('../../assets/images/nood-brand-logo.png')}
        resizeMode="contain"
        style={styles.logo}
      />
      <Text style={styles.title}>Wishlist</Text>
      <Text style={styles.copy}>Saved items will show here once customers start hearting products.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: '#fff',
  },
  logo: {
    width: 116,
    height: 40,
    marginBottom: 18,
  },
  title: {
    fontSize: 28,
    fontWeight: '900',
    color: '#111',
  },
  copy: {
    marginTop: 10,
    textAlign: 'center',
    fontSize: 15,
    lineHeight: 22,
    color: '#666',
    fontWeight: '600',
  },
});
