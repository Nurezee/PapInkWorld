let preview = window.document.querySelector("#preview img");
const voir = window.document.querySelectorAll(".Voir-texte")
const fond = window.document.querySelector(".fond-noir")
let active = false;
const home = window.document.querySelector("#page_home")

voir.forEach(function(photo){

    photo.addEventListener("click", (function(){

        let image = photo.previousElementSibling;
        preview.src = image.src
        
        preview.parentElement.style.display = "block"
        fond.style.display = "block"

        active = true;
        ShowFond()

    }));

});

function ShowFond(){
    if (active){
        fond.addEventListener("click", function(){

        preview.parentElement.style.display = "none"
        fond.style.display = "none"
            
            
        });
    }
};
