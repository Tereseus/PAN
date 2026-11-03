<!--
  ImagePreviewBar.svelte — thumbnails of images the user has pasted into
  the input bar but hasn't sent yet. Click ✕ to remove a single image.
  Parent owns the actual upload + sendTerminalInput logic — we just render
  the strip and call back when the user clicks remove.

  Reads `terminal.pastedImages` from the store; mutation is signalled via
  the `onRemove(idx)` callback so the parent can decide whether to also
  cancel an in-flight upload.
-->
<script>
	import { terminal } from '$lib/stores/terminal.svelte.js';

	let {
		/** @type {(idx: number) => void} */
		onRemove = () => {},
	} = $props();
</script>

{#if terminal.pastedImages.length > 0}
	<div class="image-preview-bar">
		{#each terminal.pastedImages as img, idx}
			<div class="image-preview-item">
				<img src={img.dataUrl} alt="Pasted" class="image-preview-thumb" />
				{#if img.uploading}
					<span class="image-uploading">...</span>
				{/if}
				<button class="image-remove" onclick={() => onRemove(idx)}>&times;</button>
			</div>
		{/each}
	</div>
{/if}
