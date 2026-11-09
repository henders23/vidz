import { Film, Image as ImageIcon, Music, Plus, Trash2, Upload } from 'lucide-react';
import { MediaAsset } from '../types';
import { useStore } from '../store';
import { addMediaToTimeline, runCommand } from '../lib/commands';
import { formatBytes, formatDuration } from '../lib/util';
import { MEDIA_DRAG_TYPE } from './Timeline';

const ICONS = { video: Film, audio: Music, image: ImageIcon };

function MediaCard({ asset }: { asset: MediaAsset }) {
  const rt = useStore((s) => s.runtime[asset.id]);
  const deleteMedia = useStore((s) => s.deleteMedia);
  const used = useStore((s) => s.project.clips.some((c) => c.mediaId === asset.id));
  const Icon = ICONS[asset.kind];
  const thumb = asset.kind === 'image' ? rt?.url : rt?.poster;
  return (
    <div
      className="media-card"
      draggable
      title={`${asset.name}\n${formatBytes(asset.size)}${asset.width ? ` · ${asset.width}×${asset.height}` : ''}\nDrag to the timeline, or double-click to add at the playhead`}
      onDragStart={(e) => {
        e.dataTransfer.setData(MEDIA_DRAG_TYPE, asset.id);
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onDoubleClick={() => addMediaToTimeline(asset.id)}
    >
      <div className="media-thumb" style={thumb ? { backgroundImage: `url(${thumb})` } : undefined}>
        {!thumb && <Icon size={22} />}
        {asset.kind !== 'image' && <span className="media-duration">{formatDuration(asset.duration)}</span>}
        <div className="media-actions">
          <button title="Add to timeline at playhead" aria-label={`Add ${asset.name} to timeline`} onClick={() => addMediaToTimeline(asset.id)}>
            <Plus size={14} />
          </button>
          <button
            title="Remove from project"
            aria-label={`Remove ${asset.name}`}
            onClick={() => {
              if (!used || confirm(`"${asset.name}" is used on the timeline. Remove it and its clips?`)) deleteMedia(asset.id);
            }}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      <div className="media-name"><Icon size={12} /> <span>{asset.name}</span></div>
    </div>
  );
}

export function MediaBin() {
  const media = useStore((s) => s.project.media);
  const importing = useStore((s) => s.importing);
  return (
    <aside className="media-bin" aria-label="Media library">
      <div className="panel-title">
        Media
        <button className="btn small" onClick={() => runCommand('file.import')}><Upload size={13} /> Import</button>
      </div>
      <div className="media-grid">
        {media.map((asset) => <MediaCard key={asset.id} asset={asset} />)}
        {importing > 0 && <div className="media-card loading"><div className="media-thumb"><span className="spinner" /></div><div className="media-name">Importing…</div></div>}
        {media.length === 0 && importing === 0 && (
          <button className="media-empty" onClick={() => runCommand('file.import')}>
            <Upload size={20} />
            <span>Drop video, audio or images here</span>
            <small>or click to browse</small>
          </button>
        )}
      </div>
    </aside>
  );
}
