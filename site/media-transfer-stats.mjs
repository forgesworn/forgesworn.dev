// Decimal transfer units, retaining small nonzero readings instead of 0.0 MB.
export function transferBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—';
  const unit = value >= 1e9 ? ['GB', 1e9] : value >= 1e6 ? ['MB', 1e6] : value >= 1000 ? ['KB', 1000] : ['B', 1];
  return `${(value / unit[1]).toLocaleString('en-GB', { maximumFractionDigits: unit[1] === 1 ? 0 : 1 })} ${unit[0]}`;
}

// Observe the real HTTP loader before hls.js can transfer its ArrayBuffer to a
// worker. Peer loads never call this loader; playlists use a separate loader.
export function observeOriginLoader(BaseLoader, onResponse) {
  return class ObservedOriginLoader extends BaseLoader {
    load(context, config, callbacks) {
      return super.load(context, config, {
        ...callbacks,
        onSuccess(response, stats, ctx, details) {
          const bytes = response?.data?.byteLength;
          if (Number.isSafeInteger(bytes) && bytes >= 0) onResponse(bytes);
          return callbacks.onSuccess(response, stats, ctx, details);
        },
      });
    }
  };
}
