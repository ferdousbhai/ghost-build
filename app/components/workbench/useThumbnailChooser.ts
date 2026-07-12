import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { createScopedLogger } from 'ghostbuild-agent/utils/logger';
import { toast } from 'sonner';
import { api } from '~/lib/cloudflare/data-api';
import { useQuery } from '~/lib/cloudflare/data-hooks';
import { useChatId } from '~/lib/stores/chatId';
import { useSessionId } from '~/lib/stores/sessionId';
import { uploadThumbnail } from './thumbnail-upload.client';

const logger = createScopedLogger('ThumbnailChooser');

interface ThumbnailChooserControllerOptions {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestCapture?: () => Promise<string>;
}

export function useThumbnailChooser({ isOpen, onOpenChange, onRequestCapture }: ThumbnailChooserControllerOptions) {
  const [isCapturing, setIsCapturing] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [optimisticUploadedPreview, setOptimisticUploadedPreview] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const fileReaderRef = useRef<FileReader | null>(null);
  const optimisticPreviewTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const operationGenerationRef = useRef(0);
  const mountedRef = useRef(true);
  const sessionId = useSessionId();
  const chatId = useChatId();
  const queryClient = useQueryClient();
  const currentShare = useQuery(api.socialShare.getCurrentSocialShare, { id: chatId, sessionId });
  const currentThumbnail = currentShare?.thumbnailUrl ?? null;

  const cancelPendingWork = useCallback(() => {
    operationGenerationRef.current += 1;
    fileReaderRef.current?.abort();
    fileReaderRef.current = null;
    if (optimisticPreviewTimeoutRef.current) {
      clearTimeout(optimisticPreviewTimeoutRef.current);
      optimisticPreviewTimeoutRef.current = null;
    }
  }, []);

  const resetLocalState = useCallback(() => {
    cancelPendingWork();
    setLocalPreview(null);
    setOptimisticUploadedPreview(null);
    setCaptureError(false);
    setIsDraggingImage(false);
    setIsCapturing(false);
    setIsUploading(false);
  }, [cancelPendingWork]);

  useEffect(() => {
    resetLocalState();
  }, [chatId, sessionId, resetLocalState]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      cancelPendingWork();
    };
  }, [cancelPendingWork]);

  useEffect(() => {
    if (!isOpen) {
      resetLocalState();
    }
  }, [isOpen, resetLocalState]);

  const captureNewImage = useCallback(async () => {
    if (!onRequestCapture) {
      return;
    }
    const generation = ++operationGenerationRef.current;
    setIsUploading(false);
    setIsCapturing(true);
    setCaptureError(false);
    try {
      const image = await onRequestCapture();
      if (mountedRef.current && operationGenerationRef.current === generation) {
        setLocalPreview(image);
      }
    } catch (error) {
      logger.warn('Failed to capture preview:', error);
      if (mountedRef.current && operationGenerationRef.current === generation) {
        setCaptureError(true);
      }
    } finally {
      if (mountedRef.current && operationGenerationRef.current === generation) {
        setIsCapturing(false);
      }
    }
  }, [onRequestCapture]);

  useEffect(() => {
    if (isOpen && !currentThumbnail && !localPreview && !optimisticUploadedPreview && onRequestCapture) {
      void captureNewImage();
    }
  }, [isOpen, currentThumbnail, localPreview, optimisticUploadedPreview, captureNewImage, onRequestCapture]);

  const uploadImage = useCallback(async () => {
    if (!localPreview) {
      return;
    }
    const imageToUpload = localPreview;
    const generation = ++operationGenerationRef.current;
    setIsUploading(true);
    try {
      await uploadThumbnail(imageToUpload, sessionId, chatId);
      if (!mountedRef.current || operationGenerationRef.current !== generation) {
        return;
      }
      setOptimisticUploadedPreview(imageToUpload);
      setLocalPreview(null);
      void queryClient
        .invalidateQueries({ queryKey: ['ghostbuild-data', api.socialShare.getCurrentSocialShare] })
        .catch((error) => logger.warn('Failed to refresh thumbnail state', error));
      if (optimisticPreviewTimeoutRef.current) {
        clearTimeout(optimisticPreviewTimeoutRef.current);
      }
      optimisticPreviewTimeoutRef.current = setTimeout(() => {
        optimisticPreviewTimeoutRef.current = null;
        if (mountedRef.current) {
          setOptimisticUploadedPreview(null);
        }
      }, 2000);
      toast.success('Thumbnail updated successfully');
    } catch (error) {
      if (!mountedRef.current || operationGenerationRef.current !== generation) {
        return;
      }
      logger.error('Failed to upload thumbnail:', error);
      toast.error('Failed to upload thumbnail');
    } finally {
      if (mountedRef.current && operationGenerationRef.current === generation) {
        setIsUploading(false);
      }
    }
  }, [sessionId, chatId, localPreview, queryClient]);

  const handleImageFile = useCallback((file: File) => {
    if (!file.type.startsWith('image/')) {
      return;
    }
    const generation = ++operationGenerationRef.current;
    setIsCapturing(false);
    setIsUploading(false);
    fileReaderRef.current?.abort();
    const reader = new FileReader();
    fileReaderRef.current = reader;
    reader.onload = (event) => {
      if (
        mountedRef.current &&
        operationGenerationRef.current === generation &&
        typeof event.target?.result === 'string'
      ) {
        setLocalPreview(event.target.result);
        setCaptureError(false);
      }
    };
    reader.onloadend = () => {
      if (fileReaderRef.current === reader) {
        fileReaderRef.current = null;
      }
    };
    reader.readAsDataURL(file);
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent) => {
      for (const item of event.clipboardData?.items ?? []) {
        if (item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) {
            handleImageFile(file);
            break;
          }
        }
      }
    },
    [handleImageFile],
  );

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [isOpen, handlePaste]);

  return {
    cancel: () => {
      operationGenerationRef.current += 1;
      fileReaderRef.current?.abort();
      setLocalPreview(null);
      setCaptureError(false);
      setIsCapturing(false);
      onOpenChange(false);
    },
    captureError,
    captureNewImage,
    fileInputRef,
    handleDragLeave: (event: DragEvent) => {
      event.preventDefault();
      setIsDraggingImage(false);
    },
    handleDragOver: (event: DragEvent) => {
      event.preventDefault();
      setIsDraggingImage(
        Array.from(event.dataTransfer.items).some((item) => item.kind === 'file' && item.type.startsWith('image/')),
      );
    },
    handleDrop: (event: DragEvent) => {
      event.preventDefault();
      setIsDraggingImage(false);
      const file = event.dataTransfer.files[0];
      if (file) {
        handleImageFile(file);
      }
    },
    handleFileChange: (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) {
        handleImageFile(file);
      }
      event.target.value = '';
    },
    isCapturing,
    isDraggingImage,
    isUploading,
    localPreview,
    openFilePicker: () => fileInputRef.current?.click(),
    previewImage: localPreview || optimisticUploadedPreview || currentThumbnail,
    uploadImage,
  };
}
