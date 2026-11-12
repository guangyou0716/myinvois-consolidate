/** An error in the user's input (CSV, supplier file or flags). The CLI exits with code 2. */
export class InputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputError';
  }
}
