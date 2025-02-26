import {
  COMPONENTS,
  DYNAMICS,
  TEMPLATES,
  EVENTS,
  PHX_COMPONENT,
  PHX_SKIP,
  PHX_MAGIC_ID,
  REPLY,
  STATIC,
  TITLE,
  STREAM,
  ROOT,
} from "./constants"

import {
  isObject,
  logError,
  isCid,
} from "./utils"

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "command",
  "embed",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr"
])
const endingTagNameChars = new Set([">", "/", " ", "\n", "\t", "\r"])

export let modifyRoot = (html, attrs, clearInnerHTML) => {
  let i = 0
  let insideComment = false
  let beforeTag, afterTag, tag, tagNameEndsAt, newHTML
  while(i < html.length){
    let char = html.charAt(i)
    if(insideComment){
      if(char === "-" && html.slice(i, i + 3) === "-->"){
        insideComment = false
        i += 3
      } else {
        i++
      }
    } else if(char === "<" && html.slice(i, i + 4) === "<!--"){
      insideComment = true
      i += 4
    } else if(char === "<"){
      beforeTag = html.slice(0, i)
      let iAtOpen = i
      for(i; i < html.length; i++){
        if(endingTagNameChars.has(html.charAt(i))){ break }
      }
      tagNameEndsAt = i
      tag = html.slice(iAtOpen + 1, tagNameEndsAt)
      break
    } else {
      i++
    }
  }
  if(!tag){ throw new Error(`malformed html ${html}`) }

  let closeAt = html.length - 1
  insideComment = false
  while(closeAt >= beforeTag.length + tag.length){
    let char = html.charAt(closeAt)
    if(insideComment){
      if(char === "-" && html.slice(closeAt - 3, closeAt) === "<!-"){
        insideComment = false
        closeAt -= 4
      } else {
        closeAt -= 1
      }
    } else if(char === ">" && html.slice(closeAt - 2, closeAt) === "--"){
      insideComment = true
      closeAt -= 3
    } else if(char === ">"){
      break
    } else {
      closeAt -= 1
    }
  }
  afterTag = html.slice(closeAt + 1, html.length)

  let attrsStr =
    Object.keys(attrs)
    .map(attr => attrs[attr] === true ? attr : `${attr}="${attrs[attr]}"`)
    .join(" ")

  if(clearInnerHTML){
    if(VOID_TAGS.has(tag)){
      newHTML = `<${tag}${attrsStr === "" ? "" : " "}${attrsStr}/>`
    } else {
      newHTML = `<${tag}${attrsStr === "" ? "" : " "}${attrsStr}></${tag}>`
    }
  } else {
    let rest = html.slice(tagNameEndsAt, closeAt + 1)
    newHTML = `<${tag}${attrsStr === "" ? "" : " "}${attrsStr}${rest}`
  }

  return [newHTML, beforeTag, afterTag]
}

export default class Rendered {
  static extract(diff){
    let {[REPLY]: reply, [EVENTS]: events, [TITLE]: title} = diff
    delete diff[REPLY]
    delete diff[EVENTS]
    delete diff[TITLE]
    return {diff, title, reply: reply || null, events: events || []}
  }

  constructor(viewId, rendered){
    this.viewId = viewId
    this.rendered = {}
    this.magicId = 0
    this.mergeDiff(rendered)
  }

  parentViewId(){ return this.viewId }

  toString(onlyCids){
    let [str, streams] = this.recursiveToString(this.rendered, this.rendered[COMPONENTS], onlyCids, true, {})
    return [str, streams]
  }

  recursiveToString(rendered, components = rendered[COMPONENTS], onlyCids, changeTracking, rootAttrs){
    onlyCids = onlyCids ? new Set(onlyCids) : null
    let output = {buffer: "", components: components, onlyCids: onlyCids, streams: new Set()}
    this.toOutputBuffer(rendered, null, output, changeTracking, rootAttrs)
    return [output.buffer, output.streams]
  }

  componentCIDs(diff){ return Object.keys(diff[COMPONENTS] || {}).map(i => parseInt(i)) }

  isComponentOnlyDiff(diff){
    if(!diff[COMPONENTS]){ return false }
    return Object.keys(diff).length === 1
  }

  getComponent(diff, cid){ return diff[COMPONENTS][cid] }

  mergeDiff(diff){
    let newc = diff[COMPONENTS]
    let cache = {}
    delete diff[COMPONENTS]
    this.rendered = this.mutableMerge(this.rendered, diff)
    this.rendered[COMPONENTS] = this.rendered[COMPONENTS] || {}

    if(newc){
      let oldc = this.rendered[COMPONENTS]

      for(let cid in newc){
        newc[cid] = this.cachedFindComponent(cid, newc[cid], oldc, newc, cache)
      }

      for(let cid in newc){ oldc[cid] = newc[cid] }
      diff[COMPONENTS] = newc
    }
  }

  cachedFindComponent(cid, cdiff, oldc, newc, cache){
    if(cache[cid]){
      return cache[cid]
    } else {
      let ndiff, stat, scid = cdiff[STATIC]

      if(isCid(scid)){
        let tdiff

        if(scid > 0){
          tdiff = this.cachedFindComponent(scid, newc[scid], oldc, newc, cache)
        } else {
          tdiff = oldc[-scid]
        }

        stat = tdiff[STATIC]
        ndiff = this.cloneMerge(tdiff, cdiff, true)
        ndiff[STATIC] = stat
      } else {
        ndiff = cdiff[STATIC] !== undefined || oldc[cid] === undefined ?
          cdiff : this.cloneMerge(oldc[cid], cdiff, false)
      }

      cache[cid] = ndiff
      return ndiff
    }
  }

  mutableMerge(target, source){
    if(source[STATIC] !== undefined){
      return source
    } else {
      this.doMutableMerge(target, source)
      return target
    }
  }

  doMutableMerge(target, source){
    for(let key in source){
      let val = source[key]
      let targetVal = target[key]
      let isObjVal = isObject(val)
      if(isObjVal && val[STATIC] === undefined && isObject(targetVal)){
        this.doMutableMerge(targetVal, val)
      } else {
        target[key] = val
      }
    }
    if(target[ROOT]){
      target.newRender = true
    }
  }

  // Merges cid trees together, copying statics from source tree.
  //
  // The `pruneMagicId` is passed to control pruning the magicId of the
  // target. We must always prune the magicId when we are sharing statics
  // from another component. If not pruning, we replicate the logic from
  // mutableMerge, where we set newRender to true if there is a root
  // (effectively forcing the new version to be rendered instead of skipped)
  //
  cloneMerge(target, source, pruneMagicId){
    let merged = {...target, ...source}
    for(let key in merged){
      let val = source[key]
      let targetVal = target[key]
      if(isObject(val) && val[STATIC] === undefined && isObject(targetVal)){
        merged[key] = this.cloneMerge(targetVal, val, pruneMagicId)
      }
    }
    if(pruneMagicId){
      delete merged.magicId
      delete merged.newRender
    } else if(target[ROOT]){
      merged.newRender = true
    }
    return merged
  }

  componentToString(cid){
    let [str, streams] = this.recursiveCIDToString(this.rendered[COMPONENTS], cid, null)
    let [strippedHTML, _before, _after] = modifyRoot(str, {})
    return [strippedHTML, streams]
  }

  pruneCIDs(cids){
    cids.forEach(cid => delete this.rendered[COMPONENTS][cid])
  }

  // private

  get(){ return this.rendered }

  isNewFingerprint(diff = {}){ return !!diff[STATIC] }

  templateStatic(part, templates){
    if(typeof (part) === "number") {
      return templates[part]
    } else {
      return part
    }
  }

  nextMagicID(){
    this.magicId++
    return `${this.parentViewId()}-${this.magicId}`
  }

  // Converts rendered tree to output buffer.
  //
  // changeTracking controls if we can apply the PHX_SKIP optimization.
  // It is disabled for comprehensions since we must re-render the entire collection
  // and no invidial element is tracked inside the comprehension.
  toOutputBuffer(rendered, templates, output, changeTracking, rootAttrs = {}){
    if(rendered[DYNAMICS]){ return this.comprehensionToBuffer(rendered, templates, output) }
    let {[STATIC]: statics} = rendered
    statics = this.templateStatic(statics, templates)
    let isRoot = rendered[ROOT]
    let prevBuffer = output.buffer
    if(isRoot){ output.buffer = "" }

    if(changeTracking && isRoot && !rendered.magicId){
      rendered.newRender = true
      rendered.magicId = this.nextMagicID()
    }

    output.buffer += statics[0]
    for(let i = 1; i < statics.length; i++){
      this.dynamicToBuffer(rendered[i - 1], templates, output, changeTracking)
      output.buffer += statics[i]
    }

    // Applies the root tag "skip" optimization if supported, which clears
    // the root tag attributes and innerHTML, and only maintains the magicId.
    // We can only skip when changeTracking is supported (outside of a comprehension),
    // and when the root element hasn't experienced an unrendered merge (newRender true).
    if(isRoot){
      let skip = false
      let attrs
      if(changeTracking || Object.keys(rootAttrs).length > 0){
        skip = !rendered.newRender
        attrs = {[PHX_MAGIC_ID]: rendered.magicId, ...rootAttrs}
      } else {
        attrs = rootAttrs
      }
      if(skip){ attrs[PHX_SKIP] = true}
      let [newRoot, commentBefore, commentAfter] = modifyRoot(output.buffer, attrs, skip)
      rendered.newRender = false
      output.buffer = prevBuffer + commentBefore + newRoot + commentAfter
    }
  }

  comprehensionToBuffer(rendered, templates, output){
    let {[DYNAMICS]: dynamics, [STATIC]: statics, [STREAM]: stream} = rendered
    let [_ref, _inserts, deleteIds, reset] = stream || [null, {}, [], null]
    statics = this.templateStatic(statics, templates)
    let compTemplates = templates || rendered[TEMPLATES]
    for(let d = 0; d < dynamics.length; d++){
      let dynamic = dynamics[d]
      output.buffer += statics[0]
      for(let i = 1; i < statics.length; i++){
        // Inside a comprehension, we don't track how dynamics change
        // over time (and features like streams would make that impossible
        // unless we move the stream diffing away from morphdom),
        // so we can't perform root change tracking.
        let changeTracking = false
        this.dynamicToBuffer(dynamic[i - 1], compTemplates, output, changeTracking)
        output.buffer += statics[i]
      }
    }

    if(stream !== undefined && (rendered[DYNAMICS].length > 0 || deleteIds.length > 0 || reset)){
      delete rendered[STREAM]
      rendered[DYNAMICS] = []
      output.streams.add(stream)
    }
  }

  dynamicToBuffer(rendered, templates, output, changeTracking){
    if(typeof (rendered) === "number"){
      let [str, streams] = this.recursiveCIDToString(output.components, rendered, output.onlyCids)
      output.buffer += str
      output.streams = new Set([...output.streams, ...streams])
    } else if(isObject(rendered)){
      this.toOutputBuffer(rendered, templates, output, changeTracking, {})
    } else {
      output.buffer += rendered
    }
  }

  recursiveCIDToString(components, cid, onlyCids){
    let component = components[cid] || logError(`no component for CID ${cid}`, components)
    let attrs = {[PHX_COMPONENT]: cid}
    let skip = onlyCids && !onlyCids.has(cid)
    // Two optimization paths apply here:
    //
    //   1. The onlyCids optimization works by the server diff telling us only specific
    //     cid's have changed. This allows us to skip rendering any component that hasn't changed,
    //     which ultimately sets PHX_SKIP root attribute and avoids rendering the innerHTML.
    //
    //   2. The root PHX_SKIP optimization generalizes to all HEEx function components, and
    //     works in the same PHX_SKIP attribute fashion as 1, but the newRender tracking is done
    //     at the general diff merge level. If we merge a diff with new dynamics, we necessariy have
    //     experienced a change which must be a newRender, and thus we can't skip the render.
    //
    // Both optimization flows apply here. newRender is set based on the onlyCids optimization, and
    // we track a deterministic magicId based on the cid.
    component.newRender = !skip
    component.magicId = `${this.parentViewId()}-c-${cid}`
    let changeTracking = true
    let [html, streams] = this.recursiveToString(component, components, onlyCids, changeTracking, attrs)

    return [html, streams]
  }
}