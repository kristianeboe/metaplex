import { LoadingOutlined } from '@ant-design/icons';
import {
  AuctionDataExtended,
  AuctionState,
  BidderMetadata,
  BidStateType,
  formatAmount,
  formatTokenAmount,
  fromLamports,
  getAuctionExtended,
  Identicon,
  loadMultipleAccounts,
  MAX_EDITION_LEN,
  MAX_METADATA_LEN,
  MetaplexModal,
  MetaplexOverlay,
  ParsedAccount,
  PriceFloorType,
  programIds,
  useConnection,
  useMint,
  useUserAccounts,
  useWalletModal,
  VaultState,
  BidRedemptionTicket,
  MAX_PRIZE_TRACKING_TICKET_SIZE,
  WinningConfigType,
} from '@oyster/common';
import { AccountLayout, MintLayout } from '@solana/spl-token';
import { useWallet } from '@solana/wallet-adapter-react';
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { Button, InputNumber, Spin } from 'antd';
import BN from 'bn.js';
import moment from 'moment';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { sendCancelBid } from '../../actions/cancelBid';
import { findEligibleParticipationBidsForRedemption } from '../../actions/claimUnusedPrizes';
import { sendPlaceBid } from '../../actions/sendPlaceBid';
import {
  eligibleForParticipationPrizeGivenWinningIndex,
  sendRedeemBid,
} from '../../actions/sendRedeemBid';
import { startAuctionManually } from '../../actions/startAuctionManually';
import { QUOTE_MINT } from '../../constants';
import { useMeta } from '../../contexts';
import {
  AuctionView,
  AuctionViewState,
  useBidsForAuction,
  useUserBalance,
} from '../../hooks';
import { AmountLabel } from '../AmountLabel';
import { AuctionCountdown, AuctionNumbers } from '../AuctionNumbers';
import { Confetti } from '../Confetti';
import { HowAuctionsWorkModal } from '../HowAuctionsWorkModal';

async function calculateTotalCostOfRedeemingOtherPeoplesBids(
  connection: Connection,
  auctionView: AuctionView,
  bids: ParsedAccount<BidderMetadata>[],
  bidRedemptions: Record<string, ParsedAccount<BidRedemptionTicket>>,
): Promise<number> {
  const accountRentExempt = await connection.getMinimumBalanceForRentExemption(
    AccountLayout.span,
  );
  const mintRentExempt = await connection.getMinimumBalanceForRentExemption(
    MintLayout.span,
  );
  const metadataRentExempt = await connection.getMinimumBalanceForRentExemption(
    MAX_METADATA_LEN,
  );
  const editionRentExempt = await connection.getMinimumBalanceForRentExemption(
    MAX_EDITION_LEN,
  );
  const prizeTrackingTicketExempt =
    await connection.getMinimumBalanceForRentExemption(
      MAX_PRIZE_TRACKING_TICKET_SIZE,
    );

  const eligibleParticipations =
    await findEligibleParticipationBidsForRedemption(
      auctionView,
      bids,
      bidRedemptions,
    );
  const max = auctionView.auction.info.bidState.max.toNumber();
  let totalWinnerItems = 0;
  for (let i = 0; i < max; i++) {
    const winner = auctionView.auction.info.bidState.getWinnerAt(i);
    if (!winner) {
      break;
    } else {
      const bid = bids.find(b => b.info.bidderPubkey === winner);
      if (bid) {
        for (
          let j = 0;
          j < auctionView.auctionManager.safetyDepositBoxesExpected.toNumber();
          j++
        ) {
          totalWinnerItems += auctionView.auctionManager
            .getAmountForWinner(i, j)
            .toNumber();
        }
      }
    }
  }
  return (
    (mintRentExempt +
      accountRentExempt +
      metadataRentExempt +
      editionRentExempt +
      prizeTrackingTicketExempt) *
    (eligibleParticipations.length + totalWinnerItems)
  );
}
function useGapTickCheck(
  value: number | undefined,
  gapTick: number | null,
  gapTime: number,
  auctionView: AuctionView,
): boolean {
  return !!useMemo(() => {
    if (gapTick && value && gapTime && !auctionView.auction.info.ended()) {
      // so we have a gap tick percentage, and a gap tick time, and a value, and we're not ended - are we within gap time?
      const now = moment().unix();
      const endedAt = auctionView.auction.info.endedAt;
      if (endedAt) {
        const ended = endedAt.toNumber();
        if (now > ended) {
          const toLamportVal = value * LAMPORTS_PER_SOL;
          // Ok, we are in gap time, since now is greater than ended and we're not actually an ended auction yt.
          // Check that the bid is at least gapTick % bigger than the next biggest one in the stack.
          for (
            let i = auctionView.auction.info.bidState.bids.length - 1;
            i > -1;
            i--
          ) {
            const bid = auctionView.auction.info.bidState.bids[i];
            const expected = bid.amount.toNumber();
            if (expected < toLamportVal) {
              const higherExpectedAmount = expected * ((100 + gapTick) / 100);

              return higherExpectedAmount > toLamportVal;
            } else if (expected === toLamportVal) {
              // If gap tick is set, no way you can bid in this case - you must bid higher.
              return true;
            }
          }
          return false;
        } else {
          return false;
        }
      }
      return false;
    }
  }, [value, gapTick, gapTime, auctionView]);
}

function useAuctionExtended(
  auctionView: AuctionView,
): ParsedAccount<AuctionDataExtended> | undefined {
  const [auctionExtended, setAuctionExtended] =
    useState<ParsedAccount<AuctionDataExtended>>();
  const { auctionDataExtended } = useMeta();

  useMemo(() => {
    const fn = async () => {
      if (!auctionExtended) {
        const PROGRAM_IDS = programIds();
        const extendedKey = await getAuctionExtended({
          auctionProgramId: PROGRAM_IDS.auction,
          resource: auctionView.vault.pubkey,
        });
        const extendedValue = auctionDataExtended[extendedKey];
        if (extendedValue) setAuctionExtended(extendedValue);
      }
    };
    fn();
  }, [auctionDataExtended, auctionExtended, setAuctionExtended]);

  return auctionExtended;
}
export const AuctionCard = ({
  auctionView,
  hideDefaultAction,
  action,
}: {
  auctionView: AuctionView;
  hideDefaultAction?: boolean;
  action?: JSX.Element;
}) => {
  const connection = useConnection();
  const { patchState } = useMeta();

  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const connect = useCallback(
    () => (wallet.wallet ? wallet.connect().catch() : setVisible(true)),
    [wallet.wallet, wallet.connect, setVisible],
  );

  const mintInfo = useMint(auctionView.auction.info.tokenMint);
  const { prizeTrackingTickets, bidRedemptions } = useMeta();
  const bids = useBidsForAuction(auctionView.auction.pubkey);

  const [value, setValue] = useState<number>();
  const [loading, setLoading] = useState<boolean>(false);

  const [showRedeemedBidModal, setShowRedeemedBidModal] =
    useState<boolean>(false);
  const [showEndingBidModal, setShowEndingBidModal] =
    useState<boolean>(false);
  const [showRedemptionIssue, setShowRedemptionIssue] =
    useState<boolean>(false);
  const [showBidPlaced, setShowBidPlaced] = useState<boolean>(false);
  const [showPlaceBid, setShowPlaceBid] = useState<boolean>(false);
  const [lastBid, setLastBid] = useState<{ amount: BN } | undefined>(undefined);

  const [showWarningModal, setShowWarningModal] = useState<boolean>(false);
  const [printingCost, setPrintingCost] = useState<number>();

  const { accountByMint } = useUserAccounts();

  const mintKey = auctionView.auction.info.tokenMint;
  const balance = useUserBalance(mintKey);

  const walletPublickKey = wallet?.publicKey?.toBase58();

  const myPayingAccount = balance.accounts[0];
  let winnerIndex: number | null = null;
  if (auctionView.myBidderPot?.pubkey)
    winnerIndex = auctionView.auction.info.bidState.getWinnerIndex(
      auctionView.myBidderPot?.info.bidderAct,
    );
  const priceFloor =
    auctionView.auction.info.priceFloor.type === PriceFloorType.Minimum
      ? auctionView.auction.info.priceFloor.minPrice?.toNumber() || 0
      : 0;
  const eligibleForOpenEdition = eligibleForParticipationPrizeGivenWinningIndex(
    winnerIndex,
    auctionView,
    auctionView.myBidderMetadata,
    auctionView.myBidRedemption,
  );
  const auctionExtended = useAuctionExtended(auctionView);

  const eligibleForAnything = winnerIndex !== null || eligibleForOpenEdition;
  const gapTime = (auctionView.auction.info.auctionGap?.toNumber() || 0) / 60;
  const gapTick = auctionExtended
    ? auctionExtended.info.gapTickSizePercentage
    : 0;
  const tickSize = auctionExtended ? auctionExtended.info.tickSize : 0;
  const tickSizeInvalid = !!(
    tickSize &&
    value &&
    (value * LAMPORTS_PER_SOL) % tickSize.toNumber() != 0
  );

  const gapBidInvalid = useGapTickCheck(value, gapTick, gapTime, auctionView);

  const isAuctionManagerAuthorityNotWalletOwner =
    auctionView.auctionManager.authority !== walletPublickKey;

  const isAuctionNotStarted =
    auctionView.auction.info.state === AuctionState.Created;

  const isUpcoming = auctionView.state === AuctionViewState.Upcoming;
  const isStarted = auctionView.state === AuctionViewState.Live;
  const participationFixedPrice =
    auctionView.auctionManager.participationConfig?.fixedPrice || 0;
  const participationOnly =
    auctionView.auctionManager.numWinners.toNumber() === 0;

  const minBid =
    tickSize &&
    (isUpcoming || bids.length === 0
      ? fromLamports(
        participationOnly ? participationFixedPrice : priceFloor,
        mintInfo,
      )
      : isStarted && bids.length > 0
        ? parseFloat(formatTokenAmount(bids[0].info.lastBid, mintInfo))
        : 9999999) +
    tickSize.toNumber() / LAMPORTS_PER_SOL;

  const invalidBid =
    tickSizeInvalid ||
    gapBidInvalid ||
    !myPayingAccount ||
    value === undefined ||
    value * LAMPORTS_PER_SOL < priceFloor ||
    (minBid && value < minBid) ||
    loading ||
    !accountByMint.get(QUOTE_MINT.toBase58());

  useEffect(() => {
    if (wallet.connected) {
      if (wallet.publicKey && !showPlaceBid) setShowPlaceBid(true);
    } else {
      if (showPlaceBid) setShowPlaceBid(false);
    }
  }, [wallet.connected]);

  const instantSale = async () => {
    setLoading(true);

    try {
      const instantSalePrice =
        auctionView.auctionDataExtended?.info.instantSalePrice;
      const winningConfigType =
        auctionView.participationItem?.winningConfigType ||
        auctionView.items[0][0].winningConfigType;
      const isAuctionItemMaster = [
        WinningConfigType.FullRightsTransfer,
        WinningConfigType.TokenOnlyTransfer,
      ].includes(winningConfigType);
      const allowBidToPublic =
        myPayingAccount &&
        !auctionView.myBidderPot &&
        isAuctionManagerAuthorityNotWalletOwner;
      const allowBidToAuctionOwner =
        myPayingAccount &&
        !isAuctionManagerAuthorityNotWalletOwner &&
        isAuctionItemMaster;

      // Placing a "bid" of the full amount results in a purchase to redeem.
      if (instantSalePrice && (allowBidToPublic || allowBidToAuctionOwner)) {
        let bidTxid: string | undefined;

        try {
          console.log('sendPlaceBid');
          const { amount, txid } = await sendPlaceBid(
            connection,
            wallet,
            myPayingAccount.pubkey,
            auctionView,
            accountByMint,
            instantSalePrice,
            'confirmed',
          );
          setLastBid({ amount });
          bidTxid = txid;
        } catch (e) {
          console.error('sendPlaceBid', e);
          return;
        }

        try {
          // Attempt to load the transaction, retrying up to 5 times
          const tryPatchMeta = async (txid: string) => {
            for (let i = 0; i < 5; ++i) {
              const tx = await connection.getTransaction(txid, {
                commitment: 'confirmed',
              });

              const keys = tx?.transaction.message.accountKeys;

              if (!keys) {
                await new Promise(o => setTimeout(o, 2000));
                continue;
              }

              const patch = await loadMultipleAccounts(
                connection,
                keys.map(k => k.toBase58()),
                'confirmed',
              );

              patchState(patch);

              {
                const auctionKey = auctionView.auction.pubkey;
                const auctionBidderKey = `${auctionKey}-${wallet.publicKey}`;

                auctionView.auction = patch.auctions[auctionKey];
                auctionView.myBidderPot =
                  patch.bidderPotsByAuctionAndBidder[auctionBidderKey];
                auctionView.myBidderMetadata =
                  patch.bidderMetadataByAuctionAndBidder[auctionBidderKey];
              }

              // Stop retrying on success
              return;
            }

            // Throw an error if we retry too many times
            throw new Error("Couldn't get PlaceBid transaction");
          };

          await tryPatchMeta(bidTxid);
        } catch (e) {
          console.error('update (post-sendPlaceBid)', e);
          return;
        }
      }

      // Claim the purchase
      try {
        await sendRedeemBid(
          connection,
          wallet,
          myPayingAccount.pubkey,
          auctionView,
          accountByMint,
          prizeTrackingTickets,
          bidRedemptions,
          bids,
        );
      } catch (e) {
        console.error('sendRedeemBid', e);
        setShowRedemptionIssue(true);
        return;
      }

      setShowRedeemedBidModal(true);
    } finally {
      setLoading(false);
    }
  };

  const isOpenEditionSale =
    auctionView.auction.info.bidState.type === BidStateType.OpenEdition;
  const isBidderPotEmpty = auctionView.myBidderPot ? Boolean(auctionView.myBidderPot?.info.emptied) : true;
  const doesInstantSaleHasNoItems =
    isBidderPotEmpty && auctionView.auction.info.bidState.max.toNumber() === bids.length;

  const shouldHideInstantSale =
    !isOpenEditionSale &&
    auctionView.isInstantSale &&
    isAuctionManagerAuthorityNotWalletOwner &&
    doesInstantSaleHasNoItems;

  const shouldHide = shouldHideInstantSale ||
    (
      auctionView.vault.info.state === VaultState.Deactivated &&
      isBidderPotEmpty
    );

  if (shouldHide) {
    return <></>;
  }

  return (
    <div>
      <div>
        {!auctionView.isInstantSale && (
          <>
            <span>Auction ends in</span>
            <div>
              <AuctionCountdown auctionView={auctionView} labels={false} />
            </div>
          </>
        )}
      </div>
      <div>
        <div>
          <AuctionNumbers
            auctionView={auctionView}
            showAsRow
            hideCountdown
            displaySOL
          />
          {showPlaceBid &&
            !hideDefaultAction &&
            wallet.connected &&
            auctionView.auction.info.ended() && (
              <Button
                disabled={
                  !myPayingAccount ||
                  (!auctionView.myBidderMetadata &&
                    isAuctionManagerAuthorityNotWalletOwner) ||
                  loading ||
                  !!auctionView.items.find(i => i.find(it => !it.metadata))
                }
                onClick={async () => {
                  setLoading(true);
                  setShowRedemptionIssue(false);
                  if (
                    wallet?.publicKey?.toBase58() ===
                    auctionView.auctionManager.authority
                  ) {
                    const totalCost =
                      await calculateTotalCostOfRedeemingOtherPeoplesBids(
                        connection,
                        auctionView,
                        bids,
                        bidRedemptions,
                      );
                    setPrintingCost(totalCost);
                    setShowWarningModal(true);
                  }
                  try {
                    if (eligibleForAnything) {
                      await sendRedeemBid(
                        connection,
                        wallet,
                        myPayingAccount.pubkey,
                        auctionView,
                        accountByMint,
                        prizeTrackingTickets,
                        bidRedemptions,
                        bids,
                      ).then(() => setShowRedeemedBidModal(true));
                    } else {
                      await sendCancelBid(
                        connection,
                        wallet,
                        myPayingAccount.pubkey,
                        auctionView,
                        accountByMint,
                        bids,
                        bidRedemptions,
                        prizeTrackingTickets,
                      );
                    }
                  } catch (e) {
                    console.error(e);
                    setShowRedemptionIssue(true);
                  }
                  setLoading(false);
                }}
              >
                {loading ||
                  auctionView.items.find(i => i.find(it => !it.metadata)) ||
                  !myPayingAccount ? (
                  <Spin />
                ) : eligibleForAnything ? (
                  `Redeem bid`
                ) : (
                  `${wallet?.publicKey &&
                    auctionView.auctionManager.authority ===
                    wallet.publicKey.toBase58()
                    ? 'Reclaim Items'
                    : 'Refund bid'
                  }`
                )}
              </Button>
            )}
          {showPlaceBid ? (
            <div>
              <AmountLabel
                title="in your wallet"
                displaySOL={true}
                amount={formatAmount(balance.balance, 2)}
                customPrefix={
                  <Identicon address={wallet?.publicKey?.toBase58()} />
                }
              />
            </div>
          ) : (
            <div>
              <HowAuctionsWorkModal />
              {!hideDefaultAction &&
                !auctionView.auction.info.ended() &&
                (wallet.connected &&
                  isAuctionNotStarted &&
                  !isAuctionManagerAuthorityNotWalletOwner ? (
                  <Button
                    disabled={loading}
                    onClick={async () => {
                      setLoading(true);
                      try {
                        await startAuctionManually(
                          connection,
                          wallet,
                          auctionView.auctionManager.instance,
                        );
                      } catch (e) {
                        console.error(e);
                      }
                      setLoading(false);
                    }}
                  >
                    {loading ? <Spin /> : 'Start auction'}
                  </Button>
                ) : (
                  <Button
                    onClick={() => {
                      if (wallet.connected) setShowPlaceBid(true);
                      else connect();
                    }}
                  >
                    Place Bid
                  </Button>
                ))}
            </div>
          )}
        </div>
        {showPlaceBid &&
          !auctionView.isInstantSale &&
          !hideDefaultAction &&
          wallet.connected &&
          !auctionView.auction.info.ended() && (
            <div>
              <div>your bid</div>
              <div>
                <div>
                  <InputNumber
                    autoFocus
                    value={value}
                    onChange={setValue}
                    precision={4}
                    formatter={value =>
                      value
                        ? `◎ ${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
                        : ''
                    }
                    placeholder={`Bid ${minBid} SOL or more`}
                  />
                </div>
                <div>
                  <Button
                    disabled={loading}
                    onClick={() => setShowPlaceBid(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    disabled={invalidBid}
                    onClick={async () => {
                      setLoading(true);
                      if (myPayingAccount && value) {
                        const bid = await sendPlaceBid(
                          connection,
                          wallet,
                          myPayingAccount.pubkey,
                          auctionView,
                          accountByMint,
                          value,
                        );
                        setLastBid(bid);
                        // setShowBidModal(false);
                        setShowBidPlaced(true);
                        setLoading(false);
                      }
                    }}
                  >
                    {loading || !accountByMint.get(QUOTE_MINT.toBase58()) ? (
                      <Spin />
                    ) : (
                      'Bid now'
                    )}
                  </Button>
                </div>
              </div>
            </div>
          )}
        {!hideDefaultAction &&
          wallet.connected &&
          !auctionView.auction.info.ended() &&
          (isAuctionNotStarted && !isAuctionManagerAuthorityNotWalletOwner ? (
            <Button
              type="primary"
              size="large"
              disabled={loading}
              onClick={async () => {
                setLoading(true);
                try {
                  await startAuctionManually(
                    connection,
                    wallet,
                    auctionView.auctionManager.instance,
                  );
                } catch (e) {
                  console.error(e);
                }
                setLoading(false);
              }}
            >
              {loading ? (
                <Spin indicator={<LoadingOutlined />} />
              ) : (
                'Start auction'
              )}
            </Button>
          ) : loading ? (
            <Spin />
          ) : (
            auctionView.isInstantSale && (
              <Button
                type="primary"
                size="large"
                disabled={loading}
                onClick={instantSale}
              >
                {!isAuctionManagerAuthorityNotWalletOwner
                  ? 'CLAIM ITEM'
                  : auctionView.myBidderPot
                    ? 'Claim Purchase'
                    : 'Buy Now'}
              </Button>
            )
          ))}
        {!hideDefaultAction && !wallet.connected && (
          <Button type="primary" size="large" onClick={connect}>
            Connect wallet to{' '}
            {auctionView.isInstantSale ? 'purchase' : 'place bid'}
          </Button>
        )}
        {action}
        {showRedemptionIssue && (
          <span>
            There was an issue redeeming or refunding your bid. Please try
            again.
          </span>
        )}
        {tickSizeInvalid && tickSize && (
          <span>Tick size is ◎{tickSize.toNumber() / LAMPORTS_PER_SOL}.</span>
        )}
        {gapBidInvalid && (
          <span>
            Your bid needs to be at least {gapTick}% larger than an existing bid
            during gap periods to be eligible.
          </span>
        )}
        {!loading && value !== undefined && showPlaceBid && invalidBid && (
          <span>Invalid amount</span>
        )}
      </div>

      <MetaplexOverlay visible={showBidPlaced}>
        <Confetti />
        <h1>Nice bid!</h1>
        <p>
          Your bid of ◎ {formatTokenAmount(lastBid?.amount, mintInfo)} was
          successful
        </p>
        <Button onClick={() => setShowBidPlaced(false)}>Got it</Button>
      </MetaplexOverlay>

      <MetaplexOverlay visible={showEndingBidModal}>
        <Confetti />
        <h1
          style={{
            fontSize: '3rem',
            marginBottom: 20,
          }}
        >
          Congratulations
        </h1>
        <p
          style={{
            color: 'white',
            textAlign: 'center',
            fontSize: '2rem',
          }}
        >
          Your sale has been ended please view your NFTs in <Link to="/artworks">My Items</Link>
          .
        </p>
        <Button
          onClick={() => setShowEndingBidModal(false)}
          className="overlay-btn"
        >
          Got it
        </Button>
      </MetaplexOverlay>

      <MetaplexOverlay visible={showRedeemedBidModal}>
        <Confetti />
        <h1>Congratulations</h1>
        <p>
          Your {auctionView.isInstantSale ? 'purchase' : 'bid'} has been
          redeemed please view your NFTs in <Link to="/artworks">My Items</Link>
          .
        </p>
        <Button onClick={() => setShowRedeemedBidModal(false)}>Got it</Button>
      </MetaplexOverlay>

      <MetaplexModal
        visible={showWarningModal}
        onCancel={() => setShowWarningModal(false)}
      >
        <h3>
          Warning: There may be some items in this auction that still are
          required by the auction for printing bidders&apos; limited or open
          edition NFTs. If you wish to withdraw them, you are agreeing to foot
          the cost of up to an estimated ◎
          <b>{(printingCost || 0) / LAMPORTS_PER_SOL}</b> plus transaction fees
          to redeem their bids for them right now.
        </h3>
      </MetaplexModal>
    </div>
  );
};
