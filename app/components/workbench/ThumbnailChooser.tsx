import { CameraIcon, CheckIcon, UploadIcon } from '@radix-ui/react-icons';
import { Button } from '@ui/Button';
import { Modal } from '@ui/Modal';
import { Spinner } from '@ui/Spinner';
import { useThumbnailChooser } from './useThumbnailChooser';

interface ThumbnailChooserProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onRequestCapture?: () => Promise<string>;
}

export function ThumbnailChooser(props: ThumbnailChooserProps) {
  const controller = useThumbnailChooser(props);
  if (!props.isOpen) {
    return null;
  }
  return (
    <Modal
      onClose={controller.cancel}
      title="Sharing thumbnail"
      description="This image is used when you share your chat with a link"
      size="lg"
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void controller.uploadImage();
        }}
        className="flex flex-col gap-4"
      >
        <div className="flex justify-center">
          <div
            onDrop={controller.handleDrop}
            onDragOver={controller.handleDragOver}
            onDragLeave={controller.handleDragLeave}
            className={`relative flex h-[600px] max-w-[800px] flex-1 flex-col items-center justify-center rounded ${
              controller.isDraggingImage
                ? 'border-2 border-dashed border-blue-500 bg-blue-500/5'
                : `${controller.isCapturing ? '' : controller.captureError ? 'border-2 border-red-500/50' : ''}`
            } transition-colors duration-150`}
          >
            {controller.previewImage ? (
              <div className="relative size-full p-4">
                <div className="flex size-full items-center justify-center">
                  <img
                    src={controller.previewImage}
                    alt="Preview"
                    crossOrigin="anonymous"
                    className="max-h-full max-w-full object-contain shadow-[0_4px_12px_rgba(0,0,0,0.2)]"
                  />
                </div>
                {controller.isDraggingImage && (
                  <div className="absolute inset-0 flex items-center justify-center bg-blue-500/5 backdrop-blur-[2px]">
                    <p className="text-lg font-medium text-blue-600">Drop image to replace</p>
                  </div>
                )}
              </div>
            ) : controller.isCapturing ? (
              <Spinner />
            ) : (
              <div className="text-content-secondary text-center">
                <p>
                  {controller.captureError
                    ? 'Upload an image to use as a thumbnail'
                    : controller.isDraggingImage
                      ? 'Drop image here'
                      : 'No preview image available'}
                </p>
                <p className="mt-2 text-sm">
                  {controller.captureError
                    ? ''
                    : controller.isDraggingImage
                      ? 'Release to add your image'
                      : 'Drop an image here, paste from clipboard, or use the buttons below'}
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            {props.onRequestCapture && !controller.captureError && (
              <Button
                variant="neutral"
                onClick={() => void controller.captureNewImage()}
                disabled={controller.isCapturing || controller.isUploading}
                tip="Take a screenshot of the current preview"
                icon={<CameraIcon />}
              >
                Take New Screenshot
              </Button>
            )}
            <Button
              variant="neutral"
              onClick={controller.openFilePicker}
              disabled={controller.isUploading}
              tip="Upload an image from your computer"
              icon={<UploadIcon />}
            >
              Paste, drag, or click to upload an image
            </Button>
            <input
              ref={controller.fileInputRef}
              type="file"
              accept="image/*"
              onChange={controller.handleFileChange}
              className="hidden"
            />
          </div>
          <div className="flex items-center gap-4">
            <Button
              variant="neutral"
              onClick={controller.cancel}
              tip={controller.isUploading ? 'Cancel the upload and close' : 'Close without saving changes'}
            >
              {controller.isUploading ? 'Cancel upload' : 'Close'}
            </Button>
            {controller.localPreview && (
              <Button
                type="submit"
                variant="primary"
                disabled={controller.isUploading}
                tip="Use this image as the thumbnail"
                icon={controller.isUploading ? <Spinner className="size-4" /> : <CheckIcon />}
              >
                {controller.isUploading ? 'Uploading...' : 'Use This Image'}
              </Button>
            )}
          </div>
        </div>
      </form>
    </Modal>
  );
}
