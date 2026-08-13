export class ComposeSaveSequence {
  private generation = 0;
  private revision = 0;

  changed() {
    this.revision += 1;
  }

  begin() {
    const generation = this.generation;
    const revision = this.revision;
    return {
      isActive: () => generation === this.generation,
      isCurrent: () => generation === this.generation && revision === this.revision
    };
  }

  reset() {
    this.generation += 1;
    this.revision = 0;
  }
}
