import { Spin } from 'antd';
import React from 'react';
import { Link } from 'react-router-dom';
import { AuctionRenderCard } from '../../components/AuctionRenderCard';
import useInfiniteScroll from 'react-infinite-scroll-hook';
import { LoadingOutlined } from '@ant-design/icons';
import { useInfiniteScrollAuctions } from '../../hooks';
import { MetaplexMasonry } from '../../components/MetaplexMasonry';

export enum LiveAuctionViewState {
  All = '0',
  Participated = '1',
  Ended = '2',
  Resale = '3',
}

export const AuctionListView = () => {
  const { auctions, loading, initLoading, hasNextPage, loadMore } = useInfiniteScrollAuctions();

  const [sentryRef] = useInfiniteScroll({
    loading,
    hasNextPage,
    onLoadMore: loadMore,
    rootMargin: '0px 0px 200px 0px',
  });

  return (
    initLoading ? (
      <div className="app-section--loading">
        <Spin indicator={<LoadingOutlined />} />
      </div>
    ) : (
      <>
        <MetaplexMasonry>
          {auctions.map((m, idx) => {
            const id = m.auction.pubkey;
            return (
              <Link to={`/auction/${id}`} key={idx}>
                <AuctionRenderCard key={id} auctionView={m} />
              </Link>
            );
          })}
        </MetaplexMasonry>
        {hasNextPage && (
          <div className="app-section--loading" ref={sentryRef}>
            <Spin indicator={<LoadingOutlined />} />
          </div>)
        }
      </>
    )
  );
};