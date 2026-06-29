import React, { useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { Swipeable } from 'react-native-gesture-handler';

export type NoodSwipeAction = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  backgroundColor: string;
  onPress: () => void;
};

type NoodSwipeableRowProps = {
  children: React.ReactNode;
  leftActions?: NoodSwipeAction[];
  rightActions?: NoodSwipeAction[];
  style?: StyleProp<ViewStyle>;
  enabled?: boolean;
};

const ACTION_WIDTH = 92;

function renderActions(actions: NoodSwipeAction[], side: 'left' | 'right') {
  return (
    <View
      style={[
        styles.actionsWrap,
        side === 'left' ? styles.actionsWrapLeft : styles.actionsWrapRight,
        { width: ACTION_WIDTH * actions.length },
      ]}
    >
      {actions.map((action) => (
        <TouchableOpacity
          key={action.key}
          style={[styles.actionButton, { backgroundColor: action.backgroundColor }]}
          activeOpacity={0.9}
          onPress={action.onPress}
        >
          <Ionicons name={action.icon} size={20} color="#fff" />
          <Text style={styles.actionLabel}>{action.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

export default function NoodSwipeableRow({
  children,
  leftActions = [],
  rightActions = [],
  style,
  enabled = true,
}: NoodSwipeableRowProps) {
  const swipeRef = useRef<Swipeable | null>(null);

  const close = () => {
    swipeRef.current?.close();
  };

  if (!enabled || (!leftActions.length && !rightActions.length)) {
    return <View style={style}>{children}</View>;
  }

  const wrappedLeft = leftActions.map((action) => ({
    ...action,
    onPress: () => {
      close();
      action.onPress();
    },
  }));

  const wrappedRight = rightActions.map((action) => ({
    ...action,
    onPress: () => {
      close();
      action.onPress();
    },
  }));

  return (
    <Swipeable
      ref={swipeRef}
      friction={2}
      overshootLeft={false}
      overshootRight={false}
      renderLeftActions={
        wrappedLeft.length ? () => renderActions(wrappedLeft, 'left') : undefined
      }
      renderRightActions={
        wrappedRight.length ? () => renderActions(wrappedRight, 'right') : undefined
      }
    >
      <View style={style}>{children}</View>
    </Swipeable>
  );
}

const styles = StyleSheet.create({
  actionsWrap: {
    flexDirection: 'row',
    height: '100%',
  },
  actionsWrapLeft: {
    justifyContent: 'flex-start',
  },
  actionsWrapRight: {
    justifyContent: 'flex-end',
  },
  actionButton: {
    width: ACTION_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    gap: 6,
  },
  actionLabel: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    textAlign: 'center',
  },
});