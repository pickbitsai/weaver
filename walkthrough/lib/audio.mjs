// Add a local TTS provider here when one is available. Providers implement
// render(slides, out) and return one audio path per slide, or an empty array.
const providers = {
  none: {
    async render() {
      process.stdout.write('Audio skipped: provider none.\n');
      return [];
    }
  }
};

export async function renderAudio(slides, out, provider = 'none') {
  const implementation = providers[provider];
  if (!implementation) throw Error(`Unknown audio provider: ${provider}`);
  return implementation.render(slides, out);
}
