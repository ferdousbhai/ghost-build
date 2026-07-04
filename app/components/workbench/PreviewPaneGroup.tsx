import { Allotment } from 'allotment';
import { Preview } from './Preview';

import 'allotment/dist/style.css';

export function PreviewPaneGroup({
  previewPanes,
  setPreviewPanes,
}: {
  previewPanes: string[];
  setPreviewPanes: (previewPanes: string[]) => void;
}) {
  return (
    <Allotment vertical minSize={150}>
      {previewPanes.map((paneId) => (
        <Preview
          key={paneId}
          showClose={previewPanes.length > 1}
          onClose={() => {
            setPreviewPanes(previewPanes.filter((id) => id !== paneId));
          }}
        />
      ))}
    </Allotment>
  );
}
