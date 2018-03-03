/**
 *
 * Albert Mas
 *
 * AUTOCOMPLETER
 *
 * Autocomplete user name and select user through tab key
 *
**/

'use strict'

class AutoCompleter {
  constructor() {
    this.tabPressCounter = null
    this.words = [] // in Orbit it is the users array
    this.matches = []
    this.onUpdated = null
  }

  onKeyDown(event, inputText, sourceWords) {
    // check if "tab" key is pressed
    if(event.which === 9) {
      event.preventDefault()

      // security check
      if(this.tabPressCounter == null) {
        // first time press
        this.tabPressCounter = 0
        // convert the text string to array
        this.words = inputText.split(' ')
        // get the last word, the one to autocomplete
        let lastWord = this.words.pop().toLowerCase()
        // check for matches in the users array
        this.matches = sourceWords.map((f) => lastWord !== '' && f.toLowerCase().startsWith(lastWord) ? f : null).filter((f) => f !== null)
      } else {
        // update variable
        this.tabPressCounter += 1
        // iterate through the matches array
        this.tabPressCounter = this.tabPressCounter % this.matches.length
        this.words.pop()
      }

      // opposite process: array to string
      if(this.matches.length > 0) {
        this.words.push(this.matches[this.tabPressCounter])
        if(this.onUpdated)
          this.onUpdated(this.words.join(' '))
      }

    } else {
      this.words = inputText.split(' ')
      this.tabPressCounter = null
      this.matches = []
    }
  }
}

export default AutoCompleter
