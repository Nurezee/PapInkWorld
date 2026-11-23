let musicIcon = window.document.querySelector(".fa-solid.fa-volume-xmark")
const music = window.document.querySelector("#info_audio")
let active = false

musicIcon.addEventListener("click", ActiverMusique)


function ActiverMusique() {

    if (!active){
    
        music.play();
        musicIcon.classList.replace("fa-volume-xmark", "fa-volume-low")
        music.volume = 0.2
        active = true;
    }
    else {
        
        music.pause();
        musicIcon.classList.replace("fa-volume-low", "fa-volume-xmark")
        active = false;
    }
};

