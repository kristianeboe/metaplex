import { useEffect, useMemo, useState } from 'react';
import { useMeta } from '../contexts';
import { Art, Artist, ArtType } from '../types';
import {
  Edition,
  IMetadataExtension,
  MasterEditionV1,
  MasterEditionV2,
  Metadata,
  ParsedAccount,
  StringPublicKey,
  useLocalStorage,
  pubkeyToString,
} from '@oyster/common';
import { WhitelistedCreator } from '@oyster/common/dist/lib/models/metaplex/index';
import { Cache } from 'three';
import { useInView } from 'react-intersection-observer';
import { maybeCDN, maybeImageCDN } from '../utils/cdn';

const metadataToArt = (
  info: Metadata | undefined,
  editions: Record<string, ParsedAccount<Edition>>,
  masterEditions: Record<
    string,
    ParsedAccount<MasterEditionV1 | MasterEditionV2>
  >,
  whitelistedCreatorsByCreator: Record<
    string,
    ParsedAccount<WhitelistedCreator>
  >,
) => {
  let type: ArtType = ArtType.NFT;
  let editionNumber: number | undefined = undefined;
  let maxSupply: number | undefined = undefined;
  let supply: number | undefined = undefined;

  if (info) {
    const masterEdition = masterEditions[info.masterEdition || ''];
    const edition = editions[info.edition || ''];
    if (edition) {
      const myMasterEdition = masterEditions[edition.info.parent || ''];
      if (myMasterEdition) {
        type = ArtType.Print;
        editionNumber = edition.info.edition.toNumber();
        supply = myMasterEdition.info?.supply.toNumber() || 0;
      }
    } else if (masterEdition) {
      type = ArtType.Master;
      maxSupply = masterEdition.info.maxSupply?.toNumber();
      supply = masterEdition.info.supply.toNumber();
    }
  }

  return {
    uri: info?.data.uri || '',
    mint: info?.mint,
    title: info?.data.name,
    creators: (info?.data.creators || [])
      .map(creator => {
        const knownCreator = whitelistedCreatorsByCreator[creator.address];

        return {
          address: creator.address,
          verified: creator.verified,
          share: creator.share,
          image: knownCreator?.info.image || '',
          name: knownCreator?.info.name || '',
          link: knownCreator?.info.twitter || '',
        } as Artist;
      })
      .sort((a, b) => {
        const share = (b.share || 0) - (a.share || 0);
        if (share === 0) {
          return a.name.localeCompare(b.name);
        }

        return share;
      }),
    seller_fee_basis_points: info?.data.sellerFeeBasisPoints || 0,
    edition: editionNumber,
    maxSupply,
    supply,
    type,
  } as Art;
};

const cachedImages = new Map<string, string>();
export const useCachedImage = (uri: string, cacheMesh?: boolean) => {
  const [cachedBlob, setCachedBlob] = useState<string | undefined>(undefined);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!uri) {
      return;
    }

    const result = cachedImages.get(uri);

    if (result) {
      setIsLoading(false);
      setCachedBlob(result);
      return;
    }

    (async () => {
      let response: Response;
      let blob: Blob;
      try {
        response = await fetch(uri, { cache: 'force-cache' });

        blob = await response.blob();

        if (blob.size === 0 || !response.ok) {
          throw new Error('No content');
        }
      } catch {
        try {
          response = await fetch(uri, { cache: 'reload' });
          blob = await response.blob();

          // If external URL, just use the uri
          if (uri?.startsWith('http')) {
            setCachedBlob(uri);
          }
        } catch {
          setIsLoading(false);
          return;
        }
      }

      if (blob.size === 0) {
        setIsLoading(false);
        return;
      }

      if (cacheMesh) {
        // extra caching for meshviewer
        Cache.enabled = true;
        Cache.add(uri, await blob.arrayBuffer());
      }
      const blobURI = URL.createObjectURL(blob);
      cachedImages.set(uri, blobURI);
      setCachedBlob(blobURI);
      setIsLoading(false);
    })();
  }, [uri, setCachedBlob, setIsLoading]);

  return { cachedBlob, isLoading };
};

export const useArt = (key?: StringPublicKey) => {
  const {
    metadataByMetadata,
    editions,
    masterEditions,
    whitelistedCreatorsByCreator,
  } = useMeta();

  const account = metadataByMetadata[key as string];

  const art = useMemo(
    () =>
      metadataToArt(
        account?.info,
        editions,
        masterEditions,
        whitelistedCreatorsByCreator,
      ),
    [account, editions, masterEditions, whitelistedCreatorsByCreator],
  );

  return art;
};

export const useExtendedArt = (id?: StringPublicKey) => {
  const { metadata } = useMeta();

  const [data, setData] = useState<IMetadataExtension>();
  const { ref, inView } = useInView({ root: null, rootMargin: '-50px 0px' });
  const localStorage = useLocalStorage();

  const key = pubkeyToString(id);

  const account = useMemo(
    () => metadata.find(a => a.pubkey === key),
    [key, metadata],
  );

  useEffect(() => {
    if (inView && id && !data) {
      if (account && account.info.data.uri) {
        const uri = maybeCDN(account.info.data.uri);

        const processJson = (extended: any) => {
          if (!extended || extended?.properties?.files?.length === 0) {
            return;
          }

          if (extended?.image) {
            const file = extended.image.startsWith('http')
              ? extended.image
              : `${account.info.data.uri}/${extended.image}`;
            extended.image = maybeImageCDN(file);
          }

          return extended;
        };

        try {
          const cached = localStorage.getItem(uri);
          if (cached) {
            setData(processJson(JSON.parse(cached)));
          } else {
            // TODO: BL handle concurrent calls to avoid double query
            fetch(uri)
              .then(response => response.json())
              .then(json => {
                try {
                  localStorage.setItem(uri, JSON.stringify(json));
                } finally {
                  setData(processJson(json));
                }
              })
              .catch(() => {
                return undefined;
              });
          }
        } catch (ex) {
          console.error(ex);
        }
      }
    }
  }, [inView, id, account]);

  return { ref, data };
};
