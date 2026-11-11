const test=require('node:test'),assert=require('node:assert/strict');
const {createHub,catalog}=require('./harness.cjs');
for(const enabled of [true,false])for(const style of ['Photo','Anime'])test(`master ${enabled}, ${style}: Boost OFF uses raw effect, ON restores choice; neither changes the other scope`,()=>{
    const p=createHub().page(),a=p.api;a.commit({enabled,mode:'Custom',customDraft:'raw effect',styleBoost:style});
    a.setStyleBoostEnabled(false);assert.equal(a.state.enabled,enabled);assert.equal(a.state.styleBoost,'');assert.equal(a.state.styleBoostLast,style);assert.equal(a.state.customDraft,'raw effect');
    const base=a.composeEffect(catalog,a.state);assert.equal(base.preview,'raw effect');assert.equal(base.insertable,enabled);
    a.setStyleBoostEnabled(true);assert.equal(a.state.styleBoost,style);assert.equal(a.state.enabled,enabled);assert.equal(a.composeEffect(catalog,a.state).preview,`raw effect, ${catalog.style_boosts[style]}`);
    a.commit({enabled:!enabled});assert.equal(a.state.styleBoost,style);assert.equal(a.state.customDraft,'raw effect');
});
for(const storageOnly of [false,true])for(const reverse of [false,true])test(`${storageOnly?'storage':'channel'} ${reverse?'reverse':'forward'}: simultaneous master/Boost intents merge and stale drafts cannot undo them`,()=>{
    const h=createHub(),a=h.page({session:'s',bcFailure:storageOnly}),b=h.page({session:'s',bcFailure:storageOnly});
    const stale=b.api.snapshot();h.hold();b.api.commit({styleBoost:'Anime'});a.api.commit({enabled:false});h.flush(reverse);
    for(const p of [a,b]){assert.equal(p.api.state.enabled,false);assert.equal(p.api.state.styleBoost,'Anime');}
    a.api.receiveState({...stale,state:{...stale.state,customDraft:'unrelated edit'},revision:{counter:100,actor:'late-draft'}});
    assert.equal(a.api.state.customDraft,'unrelated edit');assert.equal(a.api.state.enabled,false);assert.equal(a.api.state.styleBoost,'Anime');
    a.api.setStyleBoostEnabled(false);h.flush(reverse);assert.equal(b.api.state.styleBoost,'');assert.equal(b.api.state.styleBoostLast,'Anime');assert.equal(b.api.state.enabled,false);
});
test('independent control intents survive both writers closing before notifications; reload preserves OFF and last Boost choice',()=>{
    const h=createHub(),a=h.page({session:'s'}),b=h.page({session:'s'});h.hold();b.api.commit({styleBoost:'Anime'});a.api.commit({enabled:false});
    a.api.dispose();b.api.dispose();const reload=h.page({session:'s'});assert.equal(reload.api.state.enabled,false);assert.equal(reload.api.state.styleBoost,'Anime');
    reload.api.setStyleBoostEnabled(false);const again=h.page({session:'s'});assert.equal(again.api.state.enabled,false);assert.equal(again.api.state.styleBoost,'');assert.equal(again.api.state.styleBoostLast,'Anime');again.api.setStyleBoostEnabled(true);assert.equal(again.api.state.styleBoost,'Anime');assert.equal(again.api.state.enabled,false);
});
test('an inactive tab reads durable clocks before a new explicit control intent',()=>{
    const h=createHub(),a=h.page({session:'s'}),b=h.page({session:'s'});h.hold();
    for(let i=0;i<5;i++)a.api.commit({styleBoost:i%2?'Photo':'Anime'});
    b.api.commit({styleBoost:'Photo'});assert.equal(b.api.state.styleBoost,'Photo');h.flush(true);assert.equal(a.api.state.styleBoost,'Photo');assert.equal(b.api.state.styleBoost,'Photo');
});
test('control update applies during IME composition while text snapshot is deferred',()=>{
    const h=createHub(),a=h.page({session:'s'}),b=h.page({session:'s'});a.api.composeStart();b.api.commit({enabled:false,customDraft:'remote draft'});
    assert.equal(a.api.state.enabled,false);assert.equal(a.api.state.customDraft,'');a.api.composeEnd();assert.equal(a.api.state.customDraft,'remote draft');assert.equal(a.api.state.enabled,false);
});
test('legacy state restores independent master and active Boost; old default OFF remains OFF',()=>{
    const h=createHub(),a=h.page({session:'s'});for(const style of ['','Photo','Anime']){
        h.entries.set(a.api.keys.state,JSON.stringify({schema_version:1,state:{enabled:false,styleBoost:style},revision:{counter:3,actor:'old'}}));
        const reload=h.page({session:'s'});assert.equal(reload.api.state.enabled,false);assert.equal(reload.api.state.styleBoost,style);assert.equal(reload.api.state.styleBoostLast,style||'Photo');
    }
});
