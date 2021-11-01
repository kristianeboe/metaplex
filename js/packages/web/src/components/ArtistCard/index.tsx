import React from 'react';
import { Card } from 'antd';

import { Artist } from '../../types';

import { shortenAddress } from '@oyster/common';
import { MetaAvatar } from '../MetaAvatar';

export const ArtistCard = ({ artist, active }: { artist: Artist, active: boolean }) => {
  return (
    <Card
      hoverable
      cover={
        <div>{artist.background ? <img src={artist.background} /> : null}</div>
      }
      bordered={false}
    >
      <>
        <MetaAvatar creators={[artist]} size={64} />
        <div>{artist.name || shortenAddress(artist.address || '')}</div>
        <div>{artist.about}</div>
      </>
    </Card>
  );
};
