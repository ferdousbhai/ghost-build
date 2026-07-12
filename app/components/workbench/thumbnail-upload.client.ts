export async function uploadThumbnail(imageData: string, sessionId: string, chatId: string): Promise<void> {
  const imageResponse = await fetch(imageData);
  const blob = await imageResponse.blob();
  const query = new URLSearchParams({ sessionId, chatId });
  const response = await fetch(`/api/thumbnails?${query}`, {
    method: 'POST',
    body: blob,
  });
  if (!response.ok) {
    throw new Error('Failed to upload thumbnail');
  }
}
