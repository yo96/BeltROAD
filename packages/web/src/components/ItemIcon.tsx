import React, { useEffect, useState } from 'react';
import { getItemMeta } from '@factorio-eda/core';
import { resolveIconUrl } from '../sprites/factorioAssets';

interface ItemIconProps {
  itemId: string;
  size?: number;
  fallbackColor?: string;
  className?: string;
}

export const ItemIcon: React.FC<ItemIconProps> = ({
  itemId,
  size = 16,
  fallbackColor,
  className,
}) => {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [itemId]);

  if (failed || !itemId) {
    const color = fallbackColor ?? getItemMeta(itemId).color;
    return (
      <span
        className={className}
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          borderRadius: '50%',
          backgroundColor: color,
          border: '1px solid rgba(9, 26, 44, 0.75)',
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <img
      className={className}
      src={resolveIconUrl(itemId)}
      width={size}
      height={size}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      style={{
        width: size,
        height: size,
        objectFit: 'contain',
        display: 'block',
        flexShrink: 0,
      }}
    />
  );
};

export function formatEntityLabel(entityName: string): string {
  return getItemMeta(entityName).name;
}
