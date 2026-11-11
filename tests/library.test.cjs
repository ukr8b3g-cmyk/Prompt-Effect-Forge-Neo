const test=require('node:test'),assert=require('node:assert/strict');
const {createHub,catalog,plain}=require('./harness.cjs');
const ids=catalog.presets.map(p=>p.id), first=ids[1],second=ids[2];
const listed=(p,filter)=>plain(p.api.libraryItems(filter)).map(item=>item.id);
for(const storageOnly of [false,true])for(const reverse of [false,true]){
    const mode=`${storageOnly?'storage':'channel'} ${reverse?'reverse':'forward'}`;
    test(`${mode}: favorites persist, merge independent tabs, survive stale drafts and removal replay`,()=>{
        const hub=createHub(),a=hub.page({session:'one',bcFailure:storageOnly}),b=hub.page({session:'two',bcFailure:storageOnly});
        hub.hold();a.api.toggleFavorite(first);b.api.toggleFavorite(second);hub.flush(reverse);
        assert.deepEqual(listed(a,'favorites'),[first,second]);assert.deepEqual(listed(b,'favorites'),[first,second]);
        const old=hub.messages.find(row=>row.message.type==='library-operation'&&row.message.operation.item===first).message;
        hub.hold();a.api.toggleFavorite(first);b.api.commit({customDraft:'do not lose this'});hub.flush(reverse);
        b.api.handleMessage(old,'broadcast');b.api.readLibraryOperations();
        assert.equal(b.api.isFavorite(first),false);assert.equal(b.api.isFavorite(second),true);
        assert.equal(b.api.state.customDraft,'do not lose this');assert.equal(b.inputs.txt2img.value,'');
        a.api.dispose();b.api.dispose();const reload=hub.page({session:'three',bcFailure:storageOnly});
        assert.deepEqual(listed(reload,'favorites'),[second]);
    });
    test(`${mode}: history merges visits, is latest first, deduplicates and limits display to 20`,()=>{
        const hub=createHub(),a=hub.page({session:'a',bcFailure:storageOnly}),b=hub.page({session:'b',bcFailure:storageOnly});
        hub.hold();for(let i=1;i<=24;i++)(i%2?a:b).api.selectPreset(ids[i]);hub.flush(reverse);
        assert.deepEqual(plain(a.api.recentLibraryIds()),ids.slice(5,25).reverse());assert.deepEqual(listed(a,'recent'),listed(b,'recent'));
        a.api.selectPreset(first);a.api.selectPreset(first);
        assert.equal(listed(a,'recent')[0],first);assert.equal(listed(b,'recent').filter(id=>id===first).length,1);
        const expected=listed(a,'recent');a.api.dispose();b.api.dispose();assert.deepEqual(listed(hub.page({bcFailure:storageOnly}),'recent'),expected);
    });
}
test('filters intersect search/category; favorite toggles keep selection, Enable, custom draft and prompts',()=>{
    const p=createHub().page();p.api.toggleFavorite(first);p.api.toggleFavorite(second);p.api.setState({enabled:false,customDraft:'kept',styleBoost:'Anime'});
    const before=plain(p.api.state);p.api.toggleFavorite(first);assert.deepEqual(plain(p.api.state),before);
    p.api.setState({category:catalog.presets[2].category,query:catalog.presets[2].name});assert.deepEqual(listed(p,'favorites'),[second]);
    p.api.setState({query:'missing 274982'});assert.deepEqual(listed(p,'favorites'),[]);assert.equal(p.inputs.txt2img.value,'');
});
test('custom IDs survive rename, participate in all/favorites/recent, and deleted records never load or resurrect',()=>{
    const hub=createHub(),p=hub.page();const saved=p.api.saveCustomRecord('My effect','raw custom text').record;
    p.api.toggleFavorite(saved.id);p.api.loadCustom(saved.id);assert.equal(listed(p,'favorites')[0],saved.id);assert.equal(listed(p,'recent')[0],saved.id);
    p.api.saveCustomRecord('Renamed effect','changed custom text',saved.id,1);
    assert.equal(p.api.libraryItems('favorites')[0].name,'Renamed effect');
    p.localStorage.removeItem(p.api.keys.custom+saved.id.slice(7));assert.deepEqual(listed(p,'favorites'),[]);assert.deepEqual(listed(p,'recent'),[]);
    assert.equal(p.api.state.customDraft,'raw custom text');assert.equal(p.api.loadCustomRecords().records.length,0);
    assert.deepEqual(listed(hub.page(),'favorites'),[]);
});
test('favorites are shared across sessions in one base path while other base paths and drafts remain independent',()=>{
    const hub=createHub(),a=hub.page({session:'one'}),b=hub.page({session:'two'}),other=hub.page({scope:'/other',session:'one'});
    b.api.commit({customDraft:'independent'});a.api.toggleFavorite(first);a.api.selectPreset(first);
    assert.equal(b.api.isFavorite(first),true);assert.equal(b.api.state.customDraft,'independent');assert.equal(b.api.state.selectedPresetId,'realistic_photo');
    assert.equal(other.api.isFavorite(first),false);assert.deepEqual(listed(other,'recent'),[]);
});
test('invalid/unknown records are preserved, storage failure keeps memory changes and does not prune durable history',()=>{
    const hub=createHub(),p=hub.page();p.api.toggleFavorite(first);p.api.selectPreset(second);
    const saved=[...hub.entries].filter(([key])=>key.startsWith(p.api.keys.library));
    hub.entries.set(p.api.keys.library+'bad',JSON.stringify({schema_version:99}));
    p.control.storageFailure=true;p.api.toggleFavorite(first);assert.equal(p.api.isFavorite(first),false);assert.equal(p.api.persistenceWarning,'storage_failed');
    for(const [key,value] of saved)assert.equal(hub.entries.get(key),value);
    p.control.storageFailure=false;const reload=hub.page();assert.equal(reload.api.isFavorite(first),true);assert.equal(reload.api.persistenceWarning,'library_unreadable');
    assert.ok(hub.entries.has(p.api.keys.library+'bad'));
    reload.api.receiveLibraryOperation({schema_version:1,kind:'recent',item:first,active:false,revision:{counter:1,actor:'x'}});
    assert.deepEqual(listed(reload,'recent'),[second]);
});
test('equal clocks resolve consistently; compacted old notifications never revive removed favorites',()=>{
    const hub=createHub(),a=hub.page(),b=hub.page();
    const base={schema_version:1,kind:'favorite',item:first,revision:{counter:123,actor:'a'},active:true};
    const removal={...base,active:false,revision:{counter:123,actor:'z'}};
    hub.hold();a.api.receiveLibraryOperation(base);b.api.receiveLibraryOperation(removal);hub.flush(true);
    a.api.receiveLibraryOperation(base);b.api.receiveLibraryOperation(base);
    assert.equal(a.api.isFavorite(first),false);assert.equal(b.api.isFavorite(first),false);assert.equal(hub.page().api.isFavorite(first),false);
    const records=[...hub.entries.keys()].filter(key=>key.startsWith(a.api.keys.library));assert.equal(records.length,1);
});
