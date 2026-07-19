export async function uploadThumbnail(
  imageData: string,
  sessionId: string,
  chatId: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<void> {
  signal.throwIfAborted();
  const imageResponse = await fetch(imageData, { signal });
  const blob = await imageResponse.blob();
  signal.throwIfAborted();
  const query = new URLSearchParams({ sessionId, chatId });
  const response = await fetch(`/api/thumbnails?${query}`, {
    method: 'POST',
    body: blob,
    signal,
  });
  if (!response.ok) {
    throw new Error('Failed to upload thumbnail');
  }
}
