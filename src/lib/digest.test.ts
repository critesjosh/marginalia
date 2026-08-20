import { describe, expect, it } from 'vitest'
import { looksRedacted } from './digest'

describe('looksRedacted', () => {
  it('spots a reply whose subject a provider scrubbed out', () => {
    // The shape reported in the wild: a passage about Nietzsche and Germany
    // came back as one about `[PERSON_NAME]` and `[ADDRESS]`.
    expect(
      looksRedacted(
        'When applying this to [ADDRESS] specifically, we have to look at the shift in ' +
          'emphasis [PERSON_NAME] identifies.',
      ),
    ).toBe(true)

    expect(looksRedacted('Reader shared a contact at [EMAIL_ADDRESS].')).toBe(true)
  })

  it('leaves ordinary notes alone', () => {
    expect(
      looksRedacted(
        'Themes: Nietzsche on Germany as a rising political power losing its cultural nerve. ' +
          'Reader pushed back on the "antipolitical" reading [see ch. 4].',
      ),
    ).toBe(false)

    // Bracketed capitals a reader could plausibly write themselves.
    expect(looksRedacted('[SIC] in the translation; [TODO] compare the German.')).toBe(false)
  })
})
